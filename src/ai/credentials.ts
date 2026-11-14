import { globalConfigDir, storedGlobalEnvValue } from "../config.js";
import { CryptoHelper } from "../cloud/crypto-helper.js";
import { nativeExecutable } from "../cloud/native-security.js";
import { readEnv } from "../project-env.js";
import { locateClaudeCli } from "../providers/claude-cli.js";
import type { AiConnectionKind, ExtractorConfig, InvestigatorConfig } from "../types.js";
import { AI_PROVIDER_PRESETS, isLocalKind } from "./providers.js";

type CredentialConfig = Pick<ExtractorConfig | InvestigatorConfig,
  "provider" | "apiKeyEnv" | "workspaceIdEnv" | "regionEnv" | "workspaceId" | "region" | "connectionId" | "connectionKind" | "connectionLabel" | "keyUpdatedAt" | "keySavedToEnv" | "preferSavedKey" | "preferSavedAwsSettings" | "requiresConsent" | "cliPath" | "envRoot">;

/** Reported as missing while the built-in default model waits for the person's opt-in. */
export const REMOTE_MODEL_CONSENT = "privacy.allowRemoteModels";

export type KeySource = "env" | "keychain" | "not-needed" | "missing";
export interface CredentialStatus {
  ok: boolean;
  keySource: KeySource;
  /** The environment variable that supplied the key, when one did. */
  envName?: string | undefined;
  /** What is missing, as environment variable names or descriptions; never values. */
  missing: string[];
}

/** OS keychain access, injectable so tests never touch the real keychain. */
export interface KeychainStore {
  get(connectionId: string): Promise<string | undefined>;
  set(connectionId: string, secret: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

/** The native helper keeps API keys in the macOS Keychain or Windows Credential Manager. */
class NativeKeychainStore extends CryptoHelper implements KeychainStore {
  private async run(operation: string, input: object): Promise<unknown> {
    return (await this.call({ directory: globalConfigDir(), operation, ...input })).result;
  }
  async get(connectionId: string): Promise<string | undefined> {
    const result = await this.run("credential-get", { account: connectionId });
    return typeof result === "string" && result ? result : undefined;
  }
  async set(connectionId: string, secret: string): Promise<void> { await this.run("credential-set", { account: connectionId, secret }); }
  async delete(connectionId: string): Promise<void> { await this.run("credential-delete", { account: connectionId }); }
}

let keychainOverride: KeychainStore | undefined;
export function keychainStore(): KeychainStore { return keychainOverride ?? new NativeKeychainStore(nativeExecutable()); }
export function setKeychainStoreForTests(store: KeychainStore | undefined): void { keychainOverride = store; cache.clear(); }
export function keychainStoreInjected(): boolean { return keychainOverride !== undefined; }

const cache = new Map<string, string>();

function kindOf(config: CredentialConfig): AiConnectionKind | undefined { return config.connectionKind; }

/** Local servers need no key; a custom endpoint needs one only when a key source was configured. */
export function needsApiKey(config: CredentialConfig): boolean {
  const kind = kindOf(config);
  if (isLocalKind(kind)) return false;
  if (kind === "openai-compatible") return Boolean(config.apiKeyEnv || config.keyUpdatedAt);
  if (kind && !AI_PROVIDER_PRESETS[kind].needsKey) return false;
  return true;
}

function keyFromEnvironment(config: CredentialConfig): string | undefined {
  if (config.preferSavedKey && config.connectionId && (config.keyUpdatedAt || config.keySavedToEnv)) {
    return config.keySavedToEnv ? storedGlobalEnvValue(config.apiKeyEnv)?.trim() || undefined : undefined;
  }
  return readEnv(config.apiKeyEnv, config.envRoot);
}

/**
 * Where the key comes from, without reading the keychain. Environment variables (including
 * values loaded from .env files) win unless the person explicitly chose the app's saved key.
 */
export function credentialStatus(config: CredentialConfig): CredentialStatus {
  const missing: string[] = [];
  let keySource: KeySource = "not-needed";
  let envName: string | undefined;
  if (needsApiKey(config)) {
    if (keyFromEnvironment(config)) { keySource = "env"; envName = config.apiKeyEnv; }
    else if (config.connectionId && config.keyUpdatedAt) keySource = "keychain";
    else { keySource = "missing"; missing.push(config.apiKeyEnv || "API key"); }
  }
  // Plan connections hold no key: one needs a ChatGPT sign-in, the other an installed Claude Code.
  if (config.connectionKind === "chatgpt") {
    if (config.keyUpdatedAt) keySource = "keychain";
    else missing.push("ChatGPT sign-in");
  }
  if (config.connectionKind === "claude-code" && !locateClaudeCli(config.cliPath)) missing.push("Claude Code CLI");
  if (config.provider === "anthropic-aws") {
    const workspaceEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
    const regionEnv = config.regionEnv ?? "AWS_REGION";
    if (!readEnv(workspaceEnv, config.envRoot) && !config.workspaceId?.trim()) missing.push(workspaceEnv);
    if (!readEnv(regionEnv, config.envRoot) && !config.region?.trim()) missing.push(regionEnv);
  }
  if (config.requiresConsent) missing.push(REMOTE_MODEL_CONSENT);
  return { ok: missing.length === 0, keySource, ...(envName ? { envName } : {}), missing };
}

export function hasCredentials(config: CredentialConfig): boolean { return credentialStatus(config).ok; }

/** The key to send, or undefined when none is needed. Keychain reads are cached per saved key. */
export async function resolveApiKey(config: CredentialConfig, label = config.connectionLabel ?? "Model provider"): Promise<string | undefined> {
  const fromEnv = keyFromEnvironment(config);
  if (fromEnv) return fromEnv;
  if (config.connectionId && config.keyUpdatedAt) {
    const cacheKey = `${config.connectionId}\u0000${config.keyUpdatedAt}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    let secret: string | undefined;
    try { secret = await keychainStore().get(config.connectionId); }
    catch { throw new Error(`${label} key could not be read from the system keychain. Open Code Butler's AI models settings and save the key again.`); }
    if (!secret) throw new Error(`${label} key is missing from the system keychain. Open Code Butler's AI models settings and save the key again.`);
    for (const key of cache.keys()) if (key.startsWith(`${config.connectionId}\u0000`)) cache.delete(key);
    cache.set(cacheKey, secret);
    return secret;
  }
  if (!needsApiKey(config)) return undefined;
  throw new Error(`${label} API key is missing; set ${config.apiKeyEnv || "an API key"} or add it in Code Butler's AI models settings`);
}

/** Non-secret effective values for display, with existing environment precedence preserved unless explicitly overridden. */
export function awsSettingsValues(config: CredentialConfig) {
  const workspaceEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
  const regionEnv = config.regionEnv ?? "AWS_REGION";
  const choose = (saved: string | undefined, environment: string | undefined) => {
    const value = saved?.trim();
    if (value && config.preferSavedAwsSettings) return { value, source: "saved" as const };
    if (environment) return { value: environment, source: "environment" as const };
    return value ? { value, source: "saved" as const } : { value: undefined, source: "missing" as const };
  };
  const workspace = choose(config.workspaceId, readEnv(workspaceEnv, config.envRoot));
  const region = choose(config.region, readEnv(regionEnv, config.envRoot));
  return { workspaceId: workspace.value, region: region.value, workspaceIdSource: workspace.source, regionSource: region.source };
}

export function resolveAwsSettings(config: CredentialConfig): { workspaceId: string; region: string } {
  const { workspaceId, region } = awsSettingsValues(config);
  const workspaceEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv = config.regionEnv ?? "AWS_REGION";
  if (!workspaceId) throw new Error(`Anthropic AWS workspace ID is missing; set ${workspaceEnv}`);
  if (!region) throw new Error(`AWS region is missing; set ${regionEnv}`);
  return { workspaceId, region };
}
