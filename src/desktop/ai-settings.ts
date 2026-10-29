import { loadGlobalAiSettings, loadGlobalJobSettings, loadProjectConfig, saveGlobalAiSettings, setGlobalEnvValue } from "../config.js";
import { credentialStatus, keychainStore, keychainStoreInjected, resolveApiKey, resolveAwsSettings, type KeySource } from "../ai/credentials.js";
import { connectionModel, DEFAULT_BACKGROUND_DAILY_TOKENS, DEFAULT_JOB_TIER, hasAiSettings } from "../ai/models.js";
import { AI_CONNECTION_KINDS, AI_PROVIDER_PRESETS } from "../ai/providers.js";
import { aiBudgetExhausted, aiUsageSummary, type AiUsageSummary } from "../ai/usage.js";
import { nativeExecutable } from "../cloud/native-security.js";
import { runAnthropicAwsMessage } from "../providers/anthropic-aws.js";
import { AI_JOBS, type AiConnectionConfig, type AiConnectionKind, type AiJob, type AiSettings, type ExtractorConfig, type ResolvedModel } from "../types.js";

export const AI_JOB_LABELS: Record<AiJob, string> = {
  extraction: "Memory extraction", review: "AI review", wording: "Wording polish", summary: "Project summary",
  investigator: "History questions", rules: "Rule drafting", consolidation: "Merging memories"
};
/** Jobs that run without anyone asking, and so pause when the daily budget is spent. */
const BACKGROUND_JOBS = new Set<AiJob>(["extraction", "review", "summary"]);

export interface AiConnectionView extends Omit<AiConnectionConfig, "keyUpdatedAt" | "keySavedToEnv"> {
  id: string;
  label: string;
  keySaved: boolean;
  keyInKeychain: boolean;
  keyInEnv: boolean;
  /** The variable this connection's key is read from, and written to in .env. */
  keyEnvName: string;
  keySource: KeySource;
  envName?: string | undefined;
  missing: string[];
  usedBy: AiJob[];
}
export interface AiJobView {
  job: AiJob;
  label: string;
  tier: "fast" | "smart";
  connectionId?: string | undefined;
  connectionLabel: string;
  model: string;
  keySource: KeySource;
  ok: boolean;
  missing: string[];
  source: ResolvedModel["source"];
  paused: boolean;
}
export interface AiSettingsView {
  /** True when no `ai` section exists yet and the view was derived from legacy settings. */
  imported: boolean;
  keychainAvailable: boolean;
  presets: Array<{ kind: AiConnectionKind; label: string; hint: string; needsKey: boolean; apiKeyEnv?: string | undefined; baseUrl?: string | undefined; suggested: { fast: string[]; smart: string[] }; modelsUrl?: string | undefined }>;
  connections: AiConnectionView[];
  tiers: NonNullable<AiSettings["tiers"]>;
  jobs: NonNullable<AiSettings["jobs"]>;
  budgets: { backgroundDailyTokens: number | null };
  effective: AiJobView[];
  usage: AiUsageSummary;
  /** A warning about the last action that still succeeded, such as a key saved only to .env. */
  notice?: string | undefined;
}

export function keychainAvailable(): boolean {
  if (keychainStoreInjected()) return true;
  if (process.platform !== "darwin" && process.platform !== "win32") return false;
  try { nativeExecutable(); return true; } catch { return false; }
}

const keychainName = () => process.platform === "win32" ? "Windows Credential Manager" : "system keychain";

/** The provider's usual variable, suffixed for a second connection of the same kind so keys never collide. */
export function defaultKeyEnv(id: string, kind: AiConnectionKind): string {
  const base = AI_PROVIDER_PRESETS[kind].apiKeyEnv ?? `${kind.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const suffix = id.startsWith(`${kind}-`) ? id.slice(kind.length + 1).toUpperCase().replace(/-/g, "_") : "";
  return suffix ? `${base}_${suffix}` : base;
}

const keyEnvOf = (id: string, connection: AiConnectionConfig) => connection.apiKeyEnv || defaultKeyEnv(id, connection.kind);

/** Removes a key the app wrote to .env, and from this process when it is still the value in use. */
function forgetEnvKey(name: string): void {
  const previous = setGlobalEnvValue(name, undefined);
  if (previous !== undefined && process.env[name] === previous) delete process.env[name];
}

function kindForLegacy(model: ExtractorConfig): AiConnectionKind {
  if (model.provider === "anthropic-aws") return "anthropic-aws";
  if (model.provider === "anthropic") return "anthropic";
  const host = (() => { try { return new URL(model.baseUrl ?? "https://api.openai.com/v1").host; } catch { return ""; } })();
  if (host === "openrouter.ai") return "openrouter";
  if (host === "api.openai.com") return "openai";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  if (host.endsWith("dashscope.aliyuncs.com") || host.endsWith("dashscope-intl.aliyuncs.com")) return "qwen";
  if (/^(127\.0\.0\.1|localhost):11434$/.test(host)) return "ollama";
  if (/^(127\.0\.0\.1|localhost):1234$/.test(host)) return "lmstudio";
  return "openai-compatible";
}

/** Turns the profiles in use today into connections and tiers, so a first save keeps everything working. */
export function importLegacySettings(extractor: ExtractorConfig, investigator: ExtractorConfig): AiSettings {
  const connections: Record<string, AiConnectionConfig> = {};
  const signature = (model: ExtractorConfig) => JSON.stringify([kindForLegacy(model), model.baseUrl ?? "", model.apiKeyEnv, model.workspaceIdEnv ?? "", model.regionEnv ?? ""]);
  const ids = new Map<string, string>();
  const connectionFor = (model: ExtractorConfig): string => {
    const key = signature(model);
    const known = ids.get(key);
    if (known) return known;
    const kind = kindForLegacy(model);
    const preset = AI_PROVIDER_PRESETS[kind];
    let id: string = kind;
    for (let n = 2; connections[id]; n += 1) id = `${kind}-${n}`;
    connections[id] = {
      kind,
      ...(model.baseUrl && model.baseUrl !== preset.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.apiKeyEnv && model.apiKeyEnv !== preset.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
      ...(model.workspaceIdEnv ? { workspaceIdEnv: model.workspaceIdEnv } : {}),
      ...(model.regionEnv ? { regionEnv: model.regionEnv } : {})
    };
    ids.set(key, id);
    return id;
  };
  const choice = (model: ExtractorConfig) => ({ connection: connectionFor(model), model: model.model, ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}) });
  return { connections, tiers: { fast: choice(extractor), smart: choice(investigator) }, jobs: {}, budgets: { backgroundDailyTokens: DEFAULT_BACKGROUND_DAILY_TOKENS } };
}

function currentSettings(): { settings: AiSettings; imported: boolean } {
  const stored = loadGlobalAiSettings();
  if (stored && hasAiSettings(stored)) return { settings: stored, imported: false };
  const global = loadGlobalJobSettings();
  const imported = importLegacySettings(global.legacyExtractor, global.legacyInvestigator);
  // Keep connections someone already added before choosing any tier.
  return { settings: { ...imported, connections: { ...imported.connections, ...(stored?.connections ?? {}) }, ...(stored?.budgets ? { budgets: stored.budgets } : {}) }, imported: true };
}

export function readAiSettings(root?: string): AiSettingsView {
  const { settings, imported } = currentSettings();
  const models = root ? loadProjectConfig(root).models! : loadGlobalJobSettings().models!;
  const limit = settings.budgets?.backgroundDailyTokens === undefined ? DEFAULT_BACKGROUND_DAILY_TOKENS : settings.budgets.backgroundDailyTokens;
  const paused = aiBudgetExhausted(limit);
  const connections = settings.connections ?? {};
  const effective: AiJobView[] = AI_JOBS.map(job => {
    const model = models[job];
    const status = credentialStatus(model);
    const choice = settings.jobs?.[job];
    return {
      job, label: AI_JOB_LABELS[job],
      tier: choice && "tier" in choice ? choice.tier : DEFAULT_JOB_TIER[job],
      ...(model.connectionId ? { connectionId: model.connectionId } : {}),
      connectionLabel: model.connectionLabel ?? AI_PROVIDER_PRESETS[kindForLegacy(model)].label,
      model: model.model, keySource: status.keySource, ok: status.ok && model.enabled !== false, missing: status.missing,
      source: model.source, paused: paused && BACKGROUND_JOBS.has(job)
    };
  });
  const usedBy = (id: string): AiJob[] => {
    const tiers = new Set<"fast" | "smart">();
    if (settings.tiers?.fast?.connection === id) tiers.add("fast");
    if (settings.tiers?.smart?.connection === id) tiers.add("smart");
    return AI_JOBS.filter(job => {
      const choice = settings.jobs?.[job];
      if (choice && "connection" in choice) return choice.connection === id;
      const tier = choice?.tier ?? DEFAULT_JOB_TIER[job];
      return tiers.has(tier) || (!settings.tiers?.[tier] && tiers.size > 0);
    });
  };
  return {
    imported,
    keychainAvailable: keychainAvailable(),
    presets: AI_CONNECTION_KINDS.map(kind => {
      const preset = AI_PROVIDER_PRESETS[kind];
      return { kind, label: preset.label, hint: preset.hint, needsKey: preset.needsKey, apiKeyEnv: preset.apiKeyEnv, baseUrl: preset.baseUrl, suggested: preset.suggested, modelsUrl: preset.modelsUrl };
    }),
    connections: Object.entries(connections).map(([id, connection]) => {
      const status = credentialStatus(connectionModel(id, connection, { model: "-" }));
      const { keyUpdatedAt, keySavedToEnv, ...rest } = connection;
      return {
        ...rest, id, label: connection.label?.trim() || AI_PROVIDER_PRESETS[connection.kind].label,
        keySaved: Boolean(keyUpdatedAt || keySavedToEnv), keyInKeychain: Boolean(keyUpdatedAt), keyInEnv: Boolean(keySavedToEnv),
        keyEnvName: keyEnvOf(id, connection), keySource: status.keySource,
        ...(status.envName ? { envName: status.envName } : {}), missing: status.missing, usedBy: usedBy(id)
      };
    }),
    tiers: settings.tiers ?? {},
    jobs: settings.jobs ?? {},
    budgets: { backgroundDailyTokens: limit },
    effective,
    usage: aiUsageSummary(new Date(), undefined, limit)
  };
}

/** Saves the page's settings. Saved-key markers stay server-side: the page cannot forge or clear them. */
export async function saveAiSettings(input: AiSettings, root?: string): Promise<AiSettingsView> {
  const { settings: current } = currentSettings();
  const previous = current.connections ?? {};
  const connections: Record<string, AiConnectionConfig> = {};
  for (const [id, connection] of Object.entries(input.connections ?? previous)) {
    const { keyUpdatedAt: _ignored, keySavedToEnv: _alsoIgnored, ...rest } = connection;
    const before = previous[id]?.kind === connection.kind ? previous[id] : undefined;
    connections[id] = { ...rest, ...(before?.keyUpdatedAt ? { keyUpdatedAt: before.keyUpdatedAt } : {}),
      // The key in .env stays reachable only while the connection still reads the variable it was written to.
      ...(before?.keySavedToEnv && keyEnvOf(id, rest) === keyEnvOf(id, before) ? { keySavedToEnv: true as const } : {}) };
  }
  const next: AiSettings = {
    connections,
    tiers: input.tiers ?? current.tiers ?? {},
    jobs: input.jobs ?? current.jobs ?? {},
    budgets: input.budgets ?? current.budgets ?? { backgroundDailyTokens: DEFAULT_BACKGROUND_DAILY_TOKENS }
  };
  const missing = [
    ...(["fast", "smart"] as const).flatMap(tier => { const id = next.tiers?.[tier]?.connection; return id && !connections[id] ? [`${tier === "fast" ? "Fast" : "Smart"} model`] : []; }),
    ...AI_JOBS.flatMap(job => { const choice = next.jobs?.[job]; return choice && "connection" in choice && !connections[choice.connection] ? [AI_JOB_LABELS[job]] : []; })
  ];
  if (missing.length) throw new Error(`Choose another provider first for: ${missing.join(", ")}.`);
  saveGlobalAiSettings(next);
  // Keys of removed connections should not linger in the keychain or in .env.
  const stillRead = new Set(Object.entries(connections).map(([id, connection]) => keyEnvOf(id, connection)));
  for (const [id, connection] of Object.entries(previous)) {
    if (connections[id]?.kind === connection.kind) continue;
    if (connection.keyUpdatedAt) { try { await keychainStore().delete(id); } catch { /* Nothing more to clean up. */ } }
    if (connection.keySavedToEnv && !stillRead.has(keyEnvOf(id, connection))) { try { forgetEnvKey(keyEnvOf(id, connection)); } catch { /* Nothing more to clean up. */ } }
  }
  return readAiSettings(root);
}

function storedConnection(id: string): { settings: AiSettings; connection: AiConnectionConfig } {
  const { settings } = currentSettings();
  const connection = settings.connections?.[id];
  if (!connection) throw new Error("That provider no longer exists. Reload the AI models page.");
  return { settings, connection };
}

/**
 * Saves a key to the keychain and, when asked, to the global .env under the connection's variable.
 * It succeeds when either store took the key; the view's notice says when the keychain did not.
 */
export async function setConnectionKey(id: string, key: string, saveToEnv: boolean, root?: string): Promise<AiSettingsView> {
  const secret = key.trim();
  if (!secret || secret.length > 4096 || /[\s"']/.test(secret)) throw new Error("Paste the API key exactly as the provider shows it.");
  const { settings, connection } = storedConnection(id);
  const envName = keyEnvOf(id, connection);
  let keychainProblem: string | undefined;
  if (!keychainAvailable()) keychainProblem = `The ${keychainName()} is not available here.`;
  else {
    try { await keychainStore().set(id, secret); }
    catch { keychainProblem = `The key could not be saved to the ${keychainName()}.`; }
  }
  if (keychainProblem && !saveToEnv) throw new Error(`${keychainProblem} Turn on "Also save to .env" to keep the key in the .env file instead.`);
  const { keyUpdatedAt: previousKeychainKey, keySavedToEnv: _previousEnvKey, ...rest } = connection;
  if (saveToEnv) {
    setGlobalEnvValue(envName, secret);
    // The key just saved should be used now, not after a restart.
    process.env[envName] = secret;
  } else if (connection.keySavedToEnv) {
    // An older key in .env would win over the new keychain key, so it goes.
    forgetEnvKey(envName);
  }
  if (keychainProblem && previousKeychainKey) { try { await keychainStore().delete(id); } catch { /* The .env key wins regardless. */ } }
  const next: AiConnectionConfig = { ...rest,
    ...(saveToEnv ? { apiKeyEnv: envName, keySavedToEnv: true as const } : {}),
    ...(keychainProblem ? {} : { keyUpdatedAt: new Date().toISOString() }) };
  saveGlobalAiSettings({ ...settings, connections: { ...settings.connections, [id]: next } });
  return { ...readAiSettings(root), ...(keychainProblem ? { notice: `${keychainProblem} The key was saved to .env as ${envName} only.` } : {}) };
}

export async function removeConnectionKey(id: string, root?: string): Promise<AiSettingsView> {
  const { settings, connection } = storedConnection(id);
  try { await keychainStore().delete(id); } catch { /* A missing entry is already removed. */ }
  if (connection.keySavedToEnv) forgetEnvKey(keyEnvOf(id, connection));
  const { keyUpdatedAt: _removed, keySavedToEnv: _removedFromEnv, ...rest } = connection;
  saveGlobalAiSettings({ ...settings, connections: { ...settings.connections, [id]: rest } });
  return readAiSettings(root);
}

export interface ConnectionTestResult { ok: boolean; detail: string; creditUsd?: number | undefined }

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "The provider rejected the key.";
  if (status === 402) return "The provider account is out of credit.";
  if (status === 404) return "The endpoint was not found; check the base URL.";
  if (status === 429) return "The provider is rate limiting requests; try again shortly.";
  return `The provider answered with status ${status}.`;
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<{ status: number; body?: unknown }> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return { status: response.status };
  return { status: response.status, body: await response.json() as unknown };
}

const asRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A cheap real request: key info, a model list, or for Claude on AWS a one-token message. */
export async function testConnection(id: string, fetchImpl: typeof fetch = fetch): Promise<ConnectionTestResult> {
  const { settings, connection } = storedConnection(id);
  const preset = AI_PROVIDER_PRESETS[connection.kind];
  const tierModel = [settings.tiers?.fast, settings.tiers?.smart].find(choice => choice?.connection === id)?.model;
  const model = connectionModel(id, connection, { model: tierModel ?? preset.suggested.fast[0] ?? "test" });
  const status = credentialStatus(model);
  if (!status.ok) return { ok: false, detail: `Missing: ${status.missing.join(", ")}.` };
  let key: string | undefined;
  try { key = await resolveApiKey(model); } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "The key could not be read." }; }
  const base = (model.baseUrl ?? "").replace(/\/$/, "");
  try {
    if (connection.kind === "anthropic-aws") {
      await runAnthropicAwsMessage({ kind: "anthropic-aws", model: model.model, maxTokens: 1, system: "Reply with OK.", messages: [{ role: "user", content: "OK" }],
        apiKeyEnv: model.apiKeyEnv, workspaceIdEnv: model.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID", regionEnv: model.regionEnv ?? "AWS_REGION",
        baseUrl: model.baseUrl, timeoutMs: 15_000, ...(key ? { apiKey: key } : {}), ...resolveAwsSettings(model) });
      return { ok: true, detail: `Claude on AWS answered using ${model.model}.` };
    }
    if (connection.kind === "anthropic") {
      const result = await getJson(`${base || "https://api.anthropic.com"}/v1/models`, { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }, fetchImpl);
      return result.status < 300 ? { ok: true, detail: "Anthropic accepted the key." } : { ok: false, detail: describeStatus(result.status) };
    }
    if (connection.kind === "openrouter") {
      const result = await getJson(`${base}/key`, { authorization: `Bearer ${key ?? ""}` }, fetchImpl);
      if (result.status >= 300) return { ok: false, detail: describeStatus(result.status) };
      const data = asRecord(asRecord(result.body)?.data);
      const limit = typeof data?.limit === "number" ? data.limit : undefined;
      const usage = typeof data?.usage === "number" ? data.usage : undefined;
      const remaining = typeof data?.limit_remaining === "number" ? data.limit_remaining : limit !== undefined && usage !== undefined ? limit - usage : undefined;
      return { ok: true, detail: remaining !== undefined ? `OpenRouter accepted the key; $${remaining.toFixed(2)} of credit left on it.` : "OpenRouter accepted the key; it has no credit limit.",
        ...(remaining !== undefined ? { creditUsd: remaining } : {}) };
    }
    const result = await getJson(`${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, fetchImpl);
    return result.status < 300 ? { ok: true, detail: `${preset.label} answered${key ? " and accepted the key" : ""}.` } : { ok: false, detail: describeStatus(result.status) };
  } catch (error) {
    const host = (() => { try { return new URL(base || "https://api.anthropic.com").host; } catch { return "the provider"; } })();
    if (error instanceof Error && /status (\d+)/.test(error.message)) return { ok: false, detail: describeStatus(Number(/status (\d+)/.exec(error.message)![1])) };
    return { ok: false, detail: `Could not reach ${host}. Check the network${connection.kind === "ollama" || connection.kind === "lmstudio" ? " and that the local server is running" : ""}.` };
  }
}

export interface ModelOption { id: string; label?: string | undefined; contextLength?: number | undefined; promptUsdPerMillion?: number | undefined; completionUsdPerMillion?: number | undefined; suggested?: "fast" | "smart" | undefined }

/** The provider's live list where it has one, with this app's suggestions first. Any id may still be typed. */
export async function listConnectionModels(id: string, fetchImpl: typeof fetch = fetch): Promise<{ models: ModelOption[]; live: boolean; detail?: string }> {
  const { connection } = storedConnection(id);
  const preset = AI_PROVIDER_PRESETS[connection.kind];
  const suggested: ModelOption[] = [
    ...preset.suggested.fast.map(model => ({ id: model, suggested: "fast" as const })),
    ...preset.suggested.smart.map(model => ({ id: model, suggested: "smart" as const }))
  ];
  const model = connectionModel(id, connection, { model: "-" });
  const base = (model.baseUrl ?? "").replace(/\/$/, "");
  let live: ModelOption[] = [];
  let detail: string | undefined;
  try {
    if (preset.modelList === "none") return { models: suggested, live: false };
    const key = credentialStatus(model).ok ? await resolveApiKey(model) : undefined;
    const result = preset.modelList === "anthropic"
      ? await getJson(`${base || "https://api.anthropic.com"}/v1/models?limit=100`, { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }, fetchImpl)
      : await getJson(`${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, fetchImpl);
    if (result.status >= 300) detail = describeStatus(result.status);
    const data = asRecord(result.body)?.data;
    if (Array.isArray(data)) {
      live = data.slice(0, 1000).flatMap((item): ModelOption[] => {
        const record = asRecord(item);
        if (typeof record?.id !== "string") return [];
        const pricing = asRecord(record.pricing);
        const perMillion = (value: unknown) => { const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN; return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1000) / 1000 : undefined; };
        const prompt = perMillion(pricing?.prompt), completion = perMillion(pricing?.completion);
        const label = typeof record.name === "string" ? record.name : typeof record.display_name === "string" ? record.display_name : undefined;
        return [{ id: record.id, ...(label ? { label } : {}),
          ...(typeof record.context_length === "number" ? { contextLength: record.context_length } : {}),
          ...(prompt !== undefined ? { promptUsdPerMillion: prompt } : {}), ...(completion !== undefined ? { completionUsdPerMillion: completion } : {}) }];
      });
    }
  } catch (error) {
    detail = error instanceof Error && /keychain/.test(error.message) ? error.message : "The model list could not be loaded; suggestions are shown instead.";
  }
  const liveIds = new Map(live.map(option => [option.id, option]));
  const merged = [
    ...suggested.map(option => ({ ...liveIds.get(option.id), ...option })),
    ...live.filter(option => !suggested.some(item => item.id === option.id)).sort((a, b) => a.id.localeCompare(b.id))
  ];
  return { models: merged, live: live.length > 0, ...(detail ? { detail } : {}) };
}
