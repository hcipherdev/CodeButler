import { existsSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { listWatchedProjects } from "../global-watch.js";
import { atomicJson, readJson } from "../cloud/state.js";
import { hasAutomaticConnectionIntent, retryAutomaticConnection, type AutomaticProjectSetup, type AutomaticConnectionOptions } from "../cloud/auto-connect.js";
import { globalRulesSyncStatus, setGlobalRulesSyncEnabled } from "../rules/sync.js";
import { StaleRuleError } from "../rules/store.js";
import { secretBinding } from "../secrets/state.js";
import { activeForegroundIntent } from "../cloud/foreground.js";
import { AutomaticAccountChangedError, captureAutomaticAccount, type AutomaticAccountContext } from "../cloud/automatic-account.js";
import type { DesktopAccountStatus } from "./account.js";
import type { SecretSyncStatus } from "../secrets/sync.js";

export interface AccountBootstrapResult {
  rules: { state: "enabled" | "paused" | "pending" | "review-required"; reason?: string };
  projects: AutomaticProjectSetup[];
  secrets?: Array<{ root: string; state: "enabled" | "pending" | "review-required"; reason?: string }>;
}
export interface AccountBootstrapOptions {
  ensureGlobalWatcher?: () => void;
  setRulesSyncEnabled?: typeof setGlobalRulesSyncEnabled;
  automaticConnection?: AutomaticConnectionOptions;
  force?: boolean;
  resumeAccountSecrets?: typeof import("../secrets/sync.js").resumeAccountSecrets;
  captureAccount?: typeof captureAutomaticAccount;
}
interface RulesIntent { server?: string; accountId?: string; retryAfter?: number; reason?: string }
const rulesIntentPath = () => join(globalConfigDir(), "cloud", "automatic-rules-setup.json");
const statusPath = () => join(globalConfigDir(), "cloud", "automatic-sync-status.json");
export function automaticSyncStatus(server: string, accountId: string): AccountBootstrapResult | undefined {
  const saved = readJson<{ server: string; accountId: string; result: AccountBootstrapResult }>(statusPath());
  return saved?.server === server && saved.accountId === accountId ? saved.result : undefined;
}
function secretSetupOutcome(root: string, outcome: SecretSyncStatus): NonNullable<AccountBootstrapResult["secrets"]>[number] | undefined {
  if (!outcome.enabled) return undefined;
  if (outcome.status === "conflict" || outcome.migration === "conflict" || outcome.conflicts?.length) return { root, state: "review-required", reason: "Secret files need review. Open this project's Sync view to choose which versions to keep." };
  if (outcome.status === "migration-required" || outcome.migration === "review-required") return { root, state: "review-required", reason: outcome.error ?? "Open Account Center to review access to this project's legacy secrets." };
  if (outcome.status === "error" || outcome.status === "failed" || outcome.status === "syncing" || outcome.migration === "pending") return { root, state: "pending", reason: outcome.error ?? outcome.phase ?? "Encrypted secrets sync will retry when access is available." };
  return { root, state: "enabled" };
}

/** Login and enrollment explicitly call this helper; status reads remain read-only. */
export async function bootstrapAccount(status: DesktopAccountStatus, options: AccountBootstrapOptions = {}): Promise<AccountBootstrapResult> {
  const result: AccountBootstrapResult = { rules: { state: "pending", reason: "Sign in and enroll this computer to sync global rules." }, projects: [] };
  const ready = status.signedIn && status.device === "enrolled";
  const account = status.server && status.accountId ? { server: status.server, accountId: status.accountId } : undefined;
  let captured: AutomaticAccountContext | undefined;
  const accountContext = async () => {
    if (!account) throw new AutomaticAccountChangedError();
    captured ??= await (options.captureAccount ?? options.automaticConnection?.captureAccount ?? captureAutomaticAccount)(account);
    await captured.assertCurrent();
    return captured;
  };
  const roots = listWatchedProjects().filter(project => existsSync(join(project.root, ".code-butler", "config.json")));
  for (const project of roots) {
    if (!options.force && activeForegroundIntent(project.root)) continue;
    try {
      if (!hasAutomaticConnectionIntent(project.root)) continue;
      result.projects.push(await retryAutomaticConnection(project.root, { ...options.automaticConnection, ready, ...(account ? { account } : {}), ...(options.force !== undefined ? { force: options.force } : {}) }));
    } catch (error) { result.projects.push({ root: project.root, state: "review-required", reason: error instanceof Error ? error.message : "Review this folder's automatic connection state." }); }
  }
  if (ready) for (const project of roots) {
    if (!options.force && activeForegroundIntent(project.root)) continue;
    try {
      const secrets = secretBinding(project.root);
      if (!secrets?.enabled) continue;
      const context = await accountContext();
      if (!options.force && secrets.version === 2 && !secrets.migration) {
        const visible = secrets.server !== context.client.server || secrets.vaultId !== context.vaultId
          ? { root: project.root, state: "review-required" as const, reason: "These secrets are connected to another account. Review this project's sync connection." }
          : secretSetupOutcome(project.root, secrets);
        if (visible) (result.secrets ??= []).push(visible);
        continue;
      }
      const resume = options.resumeAccountSecrets ?? (await import("../secrets/sync.js")).resumeAccountSecrets;
      const outcome = await resume(project.root, context.client);
      const visible = outcome ? secretSetupOutcome(project.root, outcome) : undefined;
      if (visible) (result.secrets ??= []).push(visible);
    } catch (error) { (result.secrets ??= []).push({ root: project.root, state: error instanceof AutomaticAccountChangedError ? "review-required" : "pending", reason: error instanceof Error ? error.message : "Encrypted secrets setup will retry." }); }
  }
  const previousRules = globalRulesSyncStatus();
  const prior = previousRules.binding ?? undefined;
  if (prior && !prior.enabled) result.rules = { state: "paused" };
  else if (prior && account && prior.server !== account.server) result.rules = { state: "review-required", reason: "Global rules are connected to another account. Review their sync connection." };
  else if (ready) {
    const pending = readJson<RulesIntent>(rulesIntentPath());
    const healthy = prior?.enabled && pending && pending.server === status.server && pending.accountId === status.accountId && !pending.reason;
    if (!options.force && !prior && (pending?.retryAfter ?? 0) > Date.now() && pending?.server === status.server && pending?.accountId === status.accountId) result.rules = { state: "pending", ...(pending?.reason ? { reason: pending.reason } : {}) };
    else try {
      const context = await accountContext();
      if (prior && (prior.server !== context.client.server || prior.vaultId !== context.vaultId)) result.rules = { state: "review-required", reason: "Global rules are connected to another account. Review their sync connection." };
      else if (healthy) {
        const latest = globalRulesSyncStatus();
        result.rules = latest.binding && !latest.binding.enabled ? { state: "paused" }
          : latest.controlHash === previousRules.controlHash ? { state: "enabled" }
          : { state: "review-required", reason: "The global rules connection changed during automatic setup. Review its sync connection." };
      } else {
        const enabled = await (options.setRulesSyncEnabled ?? setGlobalRulesSyncEnabled)(true, context.client, previousRules.controlHash);
        if (enabled && (enabled.server !== context.client.server || enabled.vaultId !== context.vaultId)) throw new AutomaticAccountChangedError();
        result.rules = { state: "enabled" };
        atomicJson(rulesIntentPath(), { ...account } satisfies RulesIntent);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Global rules sync will retry when connected.";
      const changedRules = error instanceof StaleRuleError ? globalRulesSyncStatus().binding : undefined;
      result.rules = changedRules && !changedRules.enabled ? { state: "paused" }
        : { state: error instanceof AutomaticAccountChangedError || error instanceof StaleRuleError || /another account/.test(reason) ? "review-required" : "pending", reason };
      atomicJson(rulesIntentPath(), { ...account, retryAfter: Date.now() + 60_000, reason } satisfies RulesIntent);
    }
  }
  if (ready && (result.rules.state === "enabled" || result.projects.some(project => project.state === "enabled") || result.secrets?.some(project => project.state === "enabled"))) {
    try { options.ensureGlobalWatcher?.(); }
    catch (error) { if (result.rules.state === "enabled") result.rules.reason = error instanceof Error ? error.message : "The shared watcher could not start."; }
  }
  if (account && status.signedIn) atomicJson(statusPath(), { ...account, result });
  return result;
}
