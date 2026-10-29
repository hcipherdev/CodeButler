import { awaitsRemoteModelConsent } from "../../ai/consent.js";
import { credentialStatus, REMOTE_MODEL_CONSENT } from "../../ai/credentials.js";
import { loadProjectConfig, readRemoteModelConsent, setRemoteModelConsent } from "../../config.js";
import { validateProjectSetupPaths } from "../../project-setup.js";
import type { ExtractorConfig, InvestigatorConfig } from "../../types.js";

export type Confirm = (question: string) => Promise<boolean>;
const USAGE = "Usage: code-butler config remote-models <on|off|status>";

/** `config remote-models`: records this device's choice in .code-butler/config.local.json. */
export function runRemoteModelsCommand(args: string[], cwd: string, stdout: (line: string) => void): number {
  const [choice, ...extra] = args;
  if (extra.length > 0 || (choice !== "on" && choice !== "off" && choice !== "status")) throw new Error(USAGE);
  if (choice === "status") {
    const recorded = readRemoteModelConsent(cwd);
    const waiting = awaitsRemoteModelConsent(loadProjectConfig(cwd));
    stdout(`allowRemoteModels=${recorded ?? "unset"} defaultModelWaiting=${waiting}`);
    return 0;
  }
  const path = setRemoteModelConsent(cwd, choice === "on");
  stdout(choice === "on"
    ? `Remote AI models allowed for this project on this device (${path})`
    : `Remote AI models off for the built-in default model on this device (${path})`);
  return 0;
}

/**
 * Settles consent before init runs any model: the flag grants it, a terminal asks, and anything
 * else leaves the default model off with a notice. Explicitly configured providers are never asked.
 */
export async function settleInitRemoteModelConsent(
  cwd: string,
  args: string[],
  io: { stdout: (line: string) => void; confirm?: Confirm | undefined }
): Promise<void> {
  validateProjectSetupPaths(cwd);
  if (args.includes("--allow-remote-models")) {
    io.stdout(`Remote AI models allowed for this project on this device (${setRemoteModelConsent(cwd, true)})`);
    return;
  }
  if (readRemoteModelConsent(cwd) !== undefined) return;
  const pending = defaultModelWaitingWithKey(cwd);
  if (!pending) return;
  const confirm = io.confirm ?? terminalConfirm();
  if (!confirm) {
    io.stdout(`${pending.envName} is set, but LLM extraction stays off until you opt in: code-butler config remote-models on`);
    return;
  }
  const allowed = await confirm(`Send coding-agent transcripts and Git diffs from this project to ${pending.host} for LLM extraction, billed to ${pending.envName}?`);
  setRemoteModelConsent(cwd, allowed);
  io.stdout(allowed
    ? "Remote AI models allowed for this project on this device"
    : "LLM extraction stays off; turn it on later with: code-butler config remote-models on");
}

/** The default model and the env var that would pay for it, when only the opt-in is missing. */
function defaultModelWaitingWithKey(cwd: string): { envName: string; host: string } | undefined {
  const config = loadProjectConfig(cwd);
  for (const model of [config.extractor, config.investigator] as Array<ExtractorConfig | InvestigatorConfig>) {
    if (!model.requiresConsent) continue;
    const status = credentialStatus(model);
    if (status.keySource !== "env" || status.missing.some(item => item !== REMOTE_MODEL_CONSENT)) continue;
    return { envName: status.envName ?? model.apiKeyEnv, host: hostOf(model) };
  }
  return undefined;
}

function hostOf(model: ExtractorConfig | InvestigatorConfig): string {
  try { return model.baseUrl ? new URL(model.baseUrl).host : model.provider; } catch { return model.provider; }
}

function terminalConfirm(): Confirm | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question) => {
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim()); }
    finally { prompt.close(); }
  };
}
