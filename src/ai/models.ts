import { AI_JOBS, type AiConnectionConfig, type AiJob, type AiJobChoice, type AiModelChoice, type AiSettings, type ExtractorConfig, type InvestigatorConfig, type ProjectConfig, type ResolvedModel } from "../types.js";
import { AI_PROVIDER_PRESETS } from "./providers.js";

export const DEFAULT_BACKGROUND_DAILY_TOKENS = 2_000_000;

/** Extraction is high-volume background work; every other job judges or writes, so it gets the smarter model. */
export const DEFAULT_JOB_TIER: Record<AiJob, "fast" | "smart"> = {
  extraction: "fast", review: "smart", wording: "smart", summary: "smart", investigator: "smart", rules: "smart", consolidation: "smart"
};

/** The provider fields a job's model carries into InvestigatorConfig and ExtractorConfig. */
export const MODEL_FIELDS = [
  "provider", "baseUrl", "model", "apiKeyEnv", "workspaceIdEnv", "regionEnv", "maxTokens",
  "connectionId", "connectionLabel", "connectionKind", "keyUpdatedAt", "workspaceId", "region", "dataCollection",
  "requiresConsent"
] as const;

export function modelFields(model: ExtractorConfig | InvestigatorConfig): ExtractorConfig {
  const result: Record<string, unknown> = {};
  for (const key of MODEL_FIELDS) if (model[key] !== undefined) result[key] = model[key];
  return result as unknown as ExtractorConfig;
}

/** One connection plus one model choice, as the request settings every client already understands. */
export function connectionModel(id: string, connection: AiConnectionConfig, choice: Pick<AiModelChoice, "model" | "maxTokens">): ExtractorConfig {
  const preset = AI_PROVIDER_PRESETS[connection.kind];
  const values: Record<string, unknown> = {
    provider: preset.provider,
    baseUrl: connection.baseUrl ?? preset.baseUrl,
    model: choice.model,
    apiKeyEnv: connection.apiKeyEnv ?? preset.apiKeyEnv ?? "",
    workspaceIdEnv: connection.workspaceIdEnv,
    regionEnv: connection.regionEnv,
    maxTokens: choice.maxTokens,
    connectionId: id,
    connectionLabel: connection.label?.trim() || preset.label,
    connectionKind: connection.kind,
    keyUpdatedAt: connection.keyUpdatedAt,
    workspaceId: connection.workspaceId,
    region: connection.region,
    dataCollection: connection.kind === "openrouter" ? connection.dataCollection ?? "deny" : undefined
  };
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return values as unknown as ExtractorConfig;
}

/** Jobs as legacy settings ran them: extraction on the extractor, everything else on the investigator. */
export function legacyJobModels(extractor: ExtractorConfig, investigator: InvestigatorConfig, rules: InvestigatorConfig = investigator): Record<AiJob, ResolvedModel> {
  const from = (job: AiJob, model: ExtractorConfig | InvestigatorConfig, enabled?: boolean): ResolvedModel =>
    ({ ...modelFields(model), job, source: "legacy", ...(enabled === false ? { enabled: false } : {}) });
  const result = {} as Record<AiJob, ResolvedModel>;
  for (const job of AI_JOBS) {
    if (job === "extraction") result[job] = from(job, extractor);
    // The summary always had a model: the investigator when enabled, otherwise the extractor.
    else if (job === "summary") result[job] = investigator.enabled ? from(job, investigator) : from(job, extractor);
    else if (job === "rules") result[job] = from(job, rules, rules.enabled);
    else result[job] = from(job, investigator, investigator.enabled);
  }
  return result;
}

export function hasAiSettings(settings: AiSettings | undefined): boolean {
  return Boolean(settings?.tiers?.fast || settings?.tiers?.smart);
}

const isModelChoice = (choice: AiJobChoice | undefined): choice is AiModelChoice => Boolean(choice && "connection" in choice);

/**
 * Applies tiers, per-job choices and a project's overrides. A tier that is not set falls back to the
 * other tier; with no tiers at all the legacy settings stay in force.
 */
export function resolveAiJobModels(
  settings: AiSettings | undefined,
  override: Pick<AiSettings, "tiers" | "jobs"> | undefined,
  legacy: Record<AiJob, ResolvedModel>
): Record<AiJob, ResolvedModel> {
  if (!hasAiSettings(settings) && !hasAiSettings(override)) return legacy;
  const connections = settings?.connections ?? {};
  const result = {} as Record<AiJob, ResolvedModel>;
  for (const job of AI_JOBS) {
    const projectChoice = override?.jobs?.[job];
    const choice = projectChoice ?? settings?.jobs?.[job];
    let picked: AiModelChoice | undefined;
    let fromProject = projectChoice !== undefined;
    if (isModelChoice(choice)) picked = choice;
    else {
      const tier = choice?.tier ?? DEFAULT_JOB_TIER[job];
      const other = tier === "fast" ? "smart" : "fast";
      // The job's own tier wins (project first), before falling back to the other tier.
      const candidates = [[override?.tiers?.[tier], true], [settings?.tiers?.[tier], false], [override?.tiers?.[other], true], [settings?.tiers?.[other], false]] as const;
      const found = candidates.find(([value]) => value !== undefined);
      picked = found?.[0];
      fromProject ||= found?.[1] ?? false;
    }
    const connection = picked ? connections[picked.connection] : undefined;
    result[job] = picked && connection
      ? { ...connectionModel(picked.connection, connection, picked), job, source: fromProject ? "project-override" : "ai" }
      : legacy[job];
  }
  return result;
}

/** The model a job runs on; hand-built configs without `models` fall back to the legacy slots. */
export function jobModel(config: Pick<ProjectConfig, "models" | "extractor" | "investigator">, job: AiJob): ResolvedModel {
  return config.models?.[job] ?? legacyJobModels(config.extractor, config.investigator)[job];
}

/** The investigator settings a job uses: its own model, keeping the investigator's search limits and switch. */
export function jobInvestigatorConfig(config: Pick<ProjectConfig, "models" | "extractor" | "investigator">, job: AiJob): InvestigatorConfig {
  const model = jobModel(config, job);
  const base: Record<string, unknown> = { ...config.investigator };
  for (const key of MODEL_FIELDS) delete base[key];
  return { ...base, ...modelFields(model), enabled: model.enabled ?? config.investigator.enabled } as InvestigatorConfig;
}
