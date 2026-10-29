import { globalConfigDir } from "../config.js";
import { CryptoHelper } from "../cloud/crypto-helper.js";
import { nativeExecutable } from "../cloud/native-security.js";
import type { AiConnectionKind, ExtractorConfig, InvestigatorConfig } from "../types.js";
import { AI_PROVIDER_PRESETS, isLocalKind } from "./providers.js";

type CredentialConfig = Pick<ExtractorConfig | InvestigatorConfig,
  "provider" | "apiKeyEnv" | "workspaceIdEnv" | "regionEnv" | "workspaceId" | "region" | "connectionId" | "connectionKind" | "connectionLabel" | "keyUpdatedAt" | "requiresConsent">;

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
const env = (name: string | undefined) => (name ? process.env[name]?.trim() : undefined) || undefined;

function kindOf(config: CredentialConfig): AiConnectionKind | undefined { return config.connectionKind; }

/** Local servers need no key; a custom endpoint needs one only when a key source was configured. */
export function needsApiKey(config: CredentialConfig): boolean {
  const kind = kindOf(config);
  if (isLocalKind(kind)) return false;
  if (kind === "openai-compatible") return Boolean(config.apiKeyEnv || config.keyUpdatedAt);
  if (kind && !AI_PROVIDER_PRESETS[kind].needsKey) return false;
  return true;
}

/**
 * Where the key comes from, without reading the keychain. Environment variables (including
 * values loaded from .env files) win over a key saved in the app.
 */
export function credentialStatus(config: CredentialConfig): CredentialStatus {
  const missing: string[] = [];
  let keySource: KeySource = "not-needed";
  let envName: string | undefined;
  if (needsApiKey(config)) {
    if (env(config.apiKeyEnv)) { keySource = "env"; envName = config.apiKeyEnv; }
    else if (config.connectionId && config.keyUpdatedAt) keySource = "keychain";
    else { keySource = "missing"; missing.push(config.apiKeyEnv || "API key"); }
  }
  if (config.provider === "anthropic-aws") {
    const workspaceEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
    const regionEnv = config.regionEnv ?? "AWS_REGION";
    if (!env(workspaceEnv) && !config.workspaceId?.trim()) missing.push(workspaceEnv);
    if (!env(regionEnv) && !config.region?.trim()) missing.push(regionEnv);
  }
  if (config.requiresConsent) missing.push(REMOTE_MODEL_CONSENT);
  return { ok: missing.length === 0, keySource, ...(envName ? { envName } : {}), missing };
}

export function hasCredentials(config: CredentialConfig): boolean { return credentialStatus(config).ok; }

/** The key to send, or undefined when none is needed. Keychain reads are cached per saved key. */
export async function resolveApiKey(config: CredentialConfig, label = config.connectionLabel ?? "Model provider"): Promise<string | undefined> {
  const fromEnv = env(config.apiKeyEnv);
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

/** Claude on AWS also needs a workspace and region; the environment wins over saved values. */
export function resolveAwsSettings(config: CredentialConfig): { workspaceId: string; region: string } {
  const workspaceEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
  const regionEnv = config.regionEnv ?? "AWS_REGION";
  const workspaceId = env(workspaceEnv) ?? config.workspaceId?.trim();
  const region = env(regionEnv) ?? config.region?.trim();
  if (!workspaceId) throw new Error(`Anthropic AWS workspace ID is missing; set ${workspaceEnv}`);
  if (!region) throw new Error(`AWS region is missing; set ${regionEnv}`);
  return { workspaceId, region };
}
