import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { DEFAULT_BACKGROUND_DAILY_TOKENS, hasAiSettings, jobInvestigatorConfig, legacyJobModels, modelFields, resolveAiJobModels } from "./ai/models.js";
import { isAiConnectionKind } from "./ai/providers.js";
import { AI_JOBS, type AiSettings } from "./types.js";
import type { ArtifactRetentionConfig, AutomaticReviewConfig, ExtractionConfig, ExtractorConfig, ExtractorConfigInput, InvestigatorConfig, InvestigatorConfigInput, LayerRetentionConfig, ProjectConfig, RedactionPatternConfig } from "./types.js";
import { validateRedactionPattern } from "./privacy/policy.js";
import { assertProjectNotRemoved } from "./cloud/removal-state.js";

interface ProjectConfigFile {
  globalRules?: { enabled?: boolean; exclude?: string[] };
  sources?: {
    git?: Partial<ProjectConfig["sources"]["git"]>;
    codex?: Partial<ProjectConfig["sources"]["codex"]>;
    claude?: Partial<ProjectConfig["sources"]["claude"]>;
  };
  extractor?: ExtractorConfigInput;
  investigator?: InvestigatorConfigInput;
  /** A project may override which models jobs use; connections and keys stay global. */
  ai?: Pick<AiSettings, "tiers" | "jobs">;
  promotion?: Partial<Omit<ProjectConfig["promotion"], "automatic">> & {
    automatic?: Partial<ProjectConfig["promotion"]["automatic"]>;
  };
  sync?: Partial<ProjectConfig["sync"]>;
  extraction?: Partial<ExtractionConfig>;
  review?: { automatic?: Partial<AutomaticReviewConfig> };
  retrieval?: Partial<ProjectConfig["retrieval"]>;
  embeddings?: Partial<ProjectConfig["embeddings"]>;
  privacy?: Partial<ProjectConfig["privacy"]>;
  retention?: {
    migrationBackups?: number;
    sources?: Partial<Record<"git" | "codex" | "claude" | "manual", { maxAgeDays?: number | null }>>;
    overrides?: Array<{ sourceId: string; maxAgeDays: number | null }>;
    layers?: Partial<Omit<LayerRetentionConfig, "branch" | "device">> & {
      branch?: Partial<LayerRetentionConfig["branch"]>;
      device?: Partial<LayerRetentionConfig["device"]>;
    };
    artifacts?: Partial<ArtifactRetentionConfig> & {
      logs?: Partial<ArtifactRetentionConfig["logs"]>;
      projectSummaryBackups?: Partial<ArtifactRetentionConfig["projectSummaryBackups"]>;
      recoveryBackups?: Partial<ArtifactRetentionConfig["recoveryBackups"]>;
      cloudHandles?: Partial<ArtifactRetentionConfig["cloudHandles"]>;
    };
  };
  deterministic?: Partial<ProjectConfig["deterministic"]> & {
    triggers?: Partial<ProjectConfig["deterministic"]["triggers"]>;
  };
}

type ProviderProfileConfig = Partial<ExtractorConfig>;

interface GlobalConfigFile {
  globalRules?: { enabled?: boolean; exclude?: string[] };
  defaults?: {
    extractorProfile?: string | undefined;
    investigatorProfile?: string | undefined;
  };
  profiles?: Record<string, ProviderProfileConfig>;
  sources?: {
    codex?: Partial<ProjectConfig["sources"]["codex"]>;
    claude?: Partial<ProjectConfig["sources"]["claude"]>;
  };
  extractor?: ExtractorConfigInput;
  investigator?: InvestigatorConfigInput;
  embeddings?: Partial<ProjectConfig["embeddings"]>;
  ai?: AiSettings;
}

type ProviderKind = "extractor" | "investigator";

const PROVIDER_KEYS = [
  "provider",
  "baseUrl",
  "model",
  "apiKeyEnv",
  "workspaceIdEnv",
  "regionEnv",
  "maxTokens"
] as const;
const PROJECT_CODE_BUTLER_IGNORE = [
  "/*",
  "!/.gitignore",
  "!/project-summary.md",
  ""
].join("\n");
const LEGACY_ENV_ONLY_IGNORE = [".env", ".env.*", "!*.example", ""].join("\n");

type ConfigObject = Record<string, any>;

export interface ConfigPortabilityIssue {
  path: string;
  reason: "device_local_path" | "device_local_source_setting" | "provider_runtime_setting";
}

export interface ConfigLocalMigrationResult {
  sharedConfigPath: string;
  localConfigPath: string;
  dryRun: boolean;
  moved: string[];
  unchanged: string[];
  conflicts: string[];
}

export function ensureProjectConfig(rootDir: string): string {
  if (existsSync(rootDir)) assertProjectNotRemoved(rootDir);
  const configPath = join(rootDir, ".code-butler", "config.json");
  mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
  ensureProjectGitignore(rootDir);
  ensureProjectEnvExample(rootDir);
  if (existsSync(configPath)) return configPath;
  ensureGlobalConfig();
  writeFileSync(configPath, "{}\n");
  return configPath;
}

export function globalConfigDir(): string {
  return resolve(process.env.CODE_BUTLER_HOME?.trim() || join(homedir(), ".config", "code-butler"));
}

export function ensureGlobalConfig(): string {
  const globalDir = globalConfigDir();
  const configPath = join(globalDir, "config.json");
  mkdirSync(globalDir, { recursive: true });
  ensureEnvGitignore(globalDir);
  ensureGlobalEnvExample(globalDir);
  if (existsSync(configPath)) return configPath;
  writeFileSync(configPath, JSON.stringify(defaultGlobalConfigFile(), null, 2));
  return configPath;
}

export function loadProjectConfig(rootDir: string): ProjectConfig {
  const configPath = ensureProjectConfig(rootDir);
  return readProjectConfig(rootDir, configPath);
}

/** Resolve the reviewer without loading a project or creating configuration files. */
export function loadGlobalReviewerConfig(): InvestigatorConfig {
  return jobInvestigatorConfig(loadGlobalJobSettings(), "rules");
}

/** Every job's model from global settings alone, as a project without overrides would use them. */
export function loadGlobalJobSettings(): Pick<ProjectConfig, "models" | "extractor" | "investigator"> & { legacyExtractor: ExtractorConfig; legacyInvestigator: InvestigatorConfig } {
  loadGlobalEnv();
  const global = loadGlobalConfig();
  const defaults = defaultConfig(globalConfigDir(), join(globalConfigDir(), "config.json"));
  const investigator = resolveProviderConfig("investigator", defaults.investigator, global, global.investigator);
  const extractor = resolveProviderConfig("extractor", defaults.extractor, global, global.extractor);
  const models = resolveAiJobModels(global.ai, undefined, legacyJobModels(extractor, investigator));
  return { models, extractor, investigator, legacyExtractor: extractor, legacyInvestigator: investigator };
}

/** The global AI settings exactly as stored; the desktop AI models page edits these. */
export function loadGlobalAiSettings(): AiSettings | undefined {
  return loadGlobalConfig().ai;
}

/** Today's cap on background AI tokens; null means no cap. Never throws, so a broken file cannot stop a call. */
export function loadAiBudget(): number | null {
  try {
    const value = loadGlobalConfig().ai?.budgets?.backgroundDailyTokens;
    return value === null ? null : value ?? DEFAULT_BACKGROUND_DAILY_TOKENS;
  } catch { return DEFAULT_BACKGROUND_DAILY_TOKENS; }
}

/**
 * Replaces the `ai` section of the global config.json after validating the whole file, keeping
 * every other key. Written atomically, so the watcher never reads half a file.
 */
export function saveGlobalAiSettings(settings: AiSettings): void {
  const globalDir = globalConfigDir();
  mkdirSync(globalDir, { recursive: true });
  const configPath = join(globalDir, "config.json");
  const current = existsSync(configPath) ? readConfigObject(configPath) : {};
  const next = { ...current, ai: settings };
  validateGlobalConfigFile(next);
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, configPath); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function loadExistingProjectConfig(rootDir: string): ProjectConfig {
  const configPath = join(rootDir, ".code-butler", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Project config not found at ${configPath}`);
  }
  return readProjectConfig(rootDir, configPath);
}

export function projectLocalConfigPath(rootDir: string): string {
  return join(rootDir, ".code-butler", "config.local.json");
}

/** This device's recorded answer, if any. Consent covers this device's keys and logs, so it is never synced. */
export function readRemoteModelConsent(rootDir: string): boolean | undefined {
  const localConfigPath = projectLocalConfigPath(rootDir);
  if (!existsSync(localConfigPath)) return undefined;
  const value = readConfigObject(localConfigPath).privacy;
  return isConfigRecord(value) && typeof value.allowRemoteModels === "boolean" ? value.allowRemoteModels : undefined;
}

export function setRemoteModelConsent(rootDir: string, allowed: boolean): string {
  ensureProjectConfig(rootDir);
  const localConfigPath = projectLocalConfigPath(rootDir);
  const local = existsSync(localConfigPath) ? readConfigObject(localConfigPath) : {};
  const next = { ...local, privacy: { ...(isConfigRecord(local.privacy) ? local.privacy : {}), allowRemoteModels: allowed } };
  validateProjectConfigFile(next);
  writeConfigObject(localConfigPath, next);
  return localConfigPath;
}

export function portableProjectConfig(config: ConfigObject): ConfigObject {
  const result: ConfigObject = {};
  for (const key of ["promotion", "deterministic", "privacy", "retention", "sync", "globalRules"]) {
    if (config[key] !== undefined) result[key] = config[key];
  }
  if (config.retrieval) result.retrieval = config.retrieval;
  if (config.sources) {
    result.sources = {};
    for (const key of ["git", "codex", "claude"]) {
      if (!config.sources[key]) continue;
      result.sources[key] = { ...config.sources[key] };
      for (const local of ["repoPath", "roots", "hookInstall", "includeDefaultRoots"]) {
        delete result.sources[key][local];
      }
    }
  }
  return result;
}

export function analyzeSharedConfigPortability(rootDir: string): ConfigPortabilityIssue[] {
  const configPath = join(rootDir, ".code-butler", "config.json");
  if (!existsSync(configPath)) return [];
  const parsed = readConfigObject(configPath);
  validateProjectConfigFile(parsed);
  return localOnlyConfigPaths(parsed).map((path) => ({
    path,
    reason: localOnlyReason(path)
  }));
}

export function migrateSharedConfigToLocal(rootDir: string, options: { apply: boolean }): ConfigLocalMigrationResult {
  const sharedConfigPath = ensureProjectConfig(rootDir);
  const localConfigPath = projectLocalConfigPath(rootDir);
  const shared = readConfigObject(sharedConfigPath);
  const local = existsSync(localConfigPath) ? readConfigObject(localConfigPath) : {};
  validateProjectConfigFile(shared);
  validateProjectConfigFile(local);

  const paths = localOnlyConfigPaths(shared);
  const result: ConfigLocalMigrationResult = {
    sharedConfigPath,
    localConfigPath,
    dryRun: !options.apply,
    moved: [],
    unchanged: [],
    conflicts: []
  };
  if (paths.length === 0) return result;

  const nextShared = cloneConfig(shared);
  const nextLocal = cloneConfig(local);
  const generatedLocalDefaults = defaultLocalConfigFile();
  for (const path of paths) {
    const value = getNested(shared, path);
    const existing = getNested(local, path);
    const generatedDefault = getNested(generatedLocalDefaults, path);
    if (existing === undefined) {
      result.moved.push(path);
      setNested(nextLocal, path, value);
    } else if (sameJson(existing, value)) {
      result.unchanged.push(path);
    } else if (generatedDefault !== undefined && sameJson(existing, generatedDefault)) {
      result.moved.push(path);
      setNested(nextLocal, path, value);
    } else {
      result.conflicts.push(path);
    }
    deleteNested(nextShared, path);
  }

  if (options.apply) {
    writeConfigObject(sharedConfigPath, nextShared);
    writeConfigObject(localConfigPath, nextLocal);
  }
  return result;
}

function readProjectConfig(rootDir: string, configPath: string): ProjectConfig {
  const butlerEnvKeys = new Set([...loadProjectEnv(rootDir), ...loadGlobalEnv()]);
  const raw = readFileSync(configPath, "utf8");
  const parsedValue: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
  validateProjectConfigFile(parsedValue);
  const localConfigPath = projectLocalConfigPath(rootDir);
  const localValue: unknown = existsSync(localConfigPath)
    ? JSON.parse(readFileSync(localConfigPath, "utf8").trim() || "{}")
    : {};
  validateProjectConfigFile(localValue);
  const globalConfig = loadGlobalConfig();
  const globalSettings = globalProjectConfig(globalConfig);
  const parsed = mergeConfigFiles(
    mergeConfigFiles(globalSettings, parsedValue as ProjectConfigFile),
    localValue as ProjectConfigFile
  );
  const defaults = defaultConfig(rootDir, configPath);

  const git = parsed.sources?.git ?? {};
  const codex = parsed.sources?.codex ?? {};
  const claude = parsed.sources?.claude ?? {};
  const deterministic = parsed.deterministic ?? {};

  return {
    configPath,
    globalRules: { enabled: parsed.globalRules?.enabled ?? true, exclude: parsed.globalRules?.exclude ?? [] },
    sources: {
      git: {
        ...defaults.sources.git,
        ...git,
        repoPath: resolveRootedPath(rootDir, git.repoPath ?? defaults.sources.git.repoPath)
      },
      codex: {
        ...defaults.sources.codex,
        ...codex,
        includeDefaultRoots: codex.includeDefaultRoots ?? defaults.sources.codex.includeDefaultRoots,
        projectOnly: codex.projectOnly ?? defaults.sources.codex.projectOnly,
        roots: normalizeCodexRoots(rootDir, codex, defaults.sources.codex.roots)
      },
      claude: {
        ...defaults.sources.claude,
        ...claude,
        projectOnly: claude.projectOnly ?? defaults.sources.claude.projectOnly,
        roots: (claude.roots ?? defaults.sources.claude.roots).map((root) => resolveRootedPath(rootDir, root))
      }
    },
    ...resolveProjectModels(defaults, globalConfig, parsed, mergeConfigFiles(parsedValue as ProjectConfigFile, localValue as ProjectConfigFile), {
      allowRemoteModels: parsed.privacy?.allowRemoteModels === true,
      butlerEnvKeys
    }),
    promotion: {
      ...defaults.promotion,
      ...(parsed.promotion ?? {}),
      // Nested so `promotion.automatic.enabled: false` alone cannot drop the
      // other automatic defaults and leave minScore undefined.
      automatic: {
        ...defaults.promotion.automatic,
        ...(parsed.promotion?.automatic ?? {})
      }
    },
    sync: {
      ...defaults.sync,
      ...(parsed.sync ?? {})
    },
    extraction: {
      ...DEFAULT_EXTRACTION_CONFIG,
      ...(parsed.extraction ?? {})
    },
    review: {
      automatic: { ...DEFAULT_AUTOMATIC_REVIEW_CONFIG, ...(parsed.review?.automatic ?? {}) }
    },
    retrieval: {
      ...defaults.retrieval,
      ...(parsed.retrieval ?? {})
    },
    embeddings: {
      ...defaults.embeddings,
      ...(parsed.embeddings ?? {})
    },
    privacy: {
      ...defaults.privacy,
      ...(parsed.privacy ?? {})
    },
    retention: {
      migrationBackups: parsed.retention?.migrationBackups ?? defaults.retention!.migrationBackups,
      sources: {
        git: { ...defaults.retention!.sources.git, ...(parsed.retention?.sources?.git ?? {}) },
        codex: { ...defaults.retention!.sources.codex, ...(parsed.retention?.sources?.codex ?? {}) },
        claude: { ...defaults.retention!.sources.claude, ...(parsed.retention?.sources?.claude ?? {}) },
        manual: { ...defaults.retention!.sources.manual, ...(parsed.retention?.sources?.manual ?? {}) }
      },
      overrides: parsed.retention?.overrides ?? defaults.retention!.overrides,
      // Nested, so a file setting only retention.layers.enabled keeps every other default.
      layers: {
        ...defaults.retention!.layers,
        ...(parsed.retention?.layers ?? {}),
        branch: {
          ...defaults.retention!.layers.branch,
          ...(parsed.retention?.layers?.branch ?? {})
        },
        device: {
          ...defaults.retention!.layers.device,
          ...(parsed.retention?.layers?.device ?? {})
        }
      },
      artifacts: {
        ...defaults.retention!.artifacts,
        ...(parsed.retention?.artifacts ?? {}),
        logs: {
          ...defaults.retention!.artifacts.logs,
          ...(parsed.retention?.artifacts?.logs ?? {})
        },
        projectSummaryBackups: {
          ...defaults.retention!.artifacts.projectSummaryBackups,
          ...(parsed.retention?.artifacts?.projectSummaryBackups ?? {})
        },
        recoveryBackups: {
          ...defaults.retention!.artifacts.recoveryBackups,
          ...(parsed.retention?.artifacts?.recoveryBackups ?? {})
        },
        cloudHandles: {
          ...defaults.retention!.artifacts.cloudHandles,
          ...(parsed.retention?.artifacts?.cloudHandles ?? {})
        }
      }
    },
    deterministic: {
      ...defaults.deterministic,
      ...deterministic,
      triggers: {
        ...defaults.deterministic.triggers,
        ...(deterministic.triggers ?? {})
      }
    }
  };
}

function defaultConfig(rootDir: string, configPath: string): ProjectConfig {
  const home = homedir();
  const codexRoots = defaultCodexRoots(home);
  return {
    configPath,
    globalRules: { enabled: true, exclude: [] },
    sources: {
      git: {
        enabled: true,
        repoPath: resolve(rootDir),
        hookInstall: false,
        maxCommits: 200,
        maxDiffChars: 12_000
      },
      codex: {
        enabled: true,
        roots: codexRoots,
        includeDefaultRoots: true,
        projectOnly: true
      },
      claude: {
        enabled: true,
        roots: [join(home, ".claude", "projects")],
        projectOnly: true
      }
    },
    extractor: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      apiKeyEnv: "OPENAI_API_KEY"
    },
    investigator: {
      enabled: true,
      mode: "native-rlm",
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      maxDepth: 3,
      maxSteps: 18,
      maxBranching: 2,
      topKPerSearch: 5,
      evidenceThreshold: 0.75,
      returnTrace: true
    },
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2,
      automatic: {
        enabled: true,
        mode: "conservative",
        minScore: 0.85,
        mergedBranches: true,
        deviceMemories: true,
        coreCandidates: true,
        singleSourceMinConfidence: 0.9
      }
    },
    sync: {
      autoSyncOnServerStart: true,
      shareLocalLayers: "durable",
      conflictPolicy: "merge"
    },
    extraction: { ...DEFAULT_EXTRACTION_CONFIG },
    review: { automatic: { ...DEFAULT_AUTOMATIC_REVIEW_CONFIG } },
    retrieval: {
      mode: "fts",
      rrfK: 60
    },
    embeddings: {
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      batchSize: 16
    },
    privacy: {
      allowRemoteEmbeddings: false,
      allowRemoteModels: false,
      redactionPatterns: []
    },
    retention: {
      migrationBackups: 2,
      sources: {
        git: { maxAgeDays: null },
        codex: { maxAgeDays: null },
        claude: { maxAgeDays: null },
        manual: { maxAgeDays: null }
      },
      overrides: [],
      // Conservative by default: only a branch that no longer exists locally ages out,
      // and only after the grace period. Idle age-out is available but off.
      layers: {
        enabled: true,
        graceDays: 30,
        branch: { onDeleted: "archive", onMerged: "keep", maxIdleDays: null },
        device: { maxIdleDays: null }
      },
      artifacts: {
        logs: { maxBytes: 5 * 1024 * 1024, maxFiles: 3 },
        projectSummaryBackups: { maxFiles: 5 },
        recoveryBackups: { maxFiles: 2, minAgeDays: 2 },
        cloudHandles: { reapStale: true }
      }
    },
    deterministic: {
      enabled: true,
      promoteStrongSignals: true,
      triggers: {
        conversationDirectives: true,
        gitChangedFiles: true,
        decisionFiles: true,
        testExpectations: true,
        packageAndConfigFacts: true,
        docsFacts: true
      }
    }
  };
}

export function validateProjectConfigFile(value: unknown): void {
  if (!isConfigRecord(value)) throw new Error("Project config must be an object");
  if (value.ai !== undefined) validateAiSettings(value.ai, "ai", false);
  const rules = optionalConfigSection(value, "globalRules");
  if (rules) {
    assertKnownKeys(rules, new Set(["enabled", "exclude"]), "globalRules");
    if (rules.enabled !== undefined && typeof rules.enabled !== "boolean") throw new Error("globalRules.enabled must be boolean");
    if (rules.exclude !== undefined && (!Array.isArray(rules.exclude) || rules.exclude.length > 1000 || rules.exclude.some(id => typeof id !== "string" || id.length > 96))) throw new Error("globalRules.exclude must be rule ids");
  }
  const retrieval = optionalConfigSection(value, "retrieval");
  if (retrieval) {
    if (retrieval.mode !== undefined && retrieval.mode !== "fts" && retrieval.mode !== "hybrid") {
      throw new Error("retrieval.mode must be fts or hybrid");
    }
    if (retrieval.rrfK !== undefined && !isPositiveInteger(retrieval.rrfK)) {
      throw new Error("retrieval.rrfK must be a positive integer");
    }
  }

  const embeddings = optionalConfigSection(value, "embeddings");
  if (embeddings) {
    if (embeddings.enabled !== undefined && typeof embeddings.enabled !== "boolean") {
      throw new Error("embeddings.enabled must be a boolean");
    }
    if (embeddings.provider !== undefined && embeddings.provider !== "openai-compatible") {
      throw new Error("embeddings.provider must be openai-compatible");
    }
    if (embeddings.baseUrl !== undefined && !isValidEmbeddingBaseUrl(embeddings.baseUrl)) {
      throw new Error("embeddings.baseUrl must be a valid HTTP(S) URL");
    }
    if (embeddings.model !== undefined && !isNonemptyString(embeddings.model)) {
      throw new Error("embeddings.model must be a nonempty string");
    }
    if (embeddings.apiKeyEnv !== undefined && !isNonemptyString(embeddings.apiKeyEnv)) {
      throw new Error("embeddings.apiKeyEnv must be a nonempty string");
    }
    if (embeddings.batchSize !== undefined && !isPositiveInteger(embeddings.batchSize)) {
      throw new Error("embeddings.batchSize must be a positive integer");
    }
  }

  const privacy = optionalConfigSection(value, "privacy");
  if (privacy) {
    assertKnownKeys(privacy, new Set(["allowRemoteEmbeddings", "allowRemoteModels", "redactionPatterns"]), "privacy");
    for (const key of ["allowRemoteEmbeddings", "allowRemoteModels"] as const) {
      if (privacy[key] !== undefined && typeof privacy[key] !== "boolean") throw new Error(`privacy.${key} must be a boolean`);
    }
    if (privacy.redactionPatterns !== undefined) {
      if (!Array.isArray(privacy.redactionPatterns)) throw new Error("privacy.redactionPatterns must be an array");
      for (const [index, pattern] of privacy.redactionPatterns.entries()) {
        if (!isConfigRecord(pattern)) throw new Error(`privacy.redactionPatterns[${index}] must be an object`);
        assertKnownKeys(pattern, new Set(["name", "kind", "pattern", "flags"]), `privacy.redactionPatterns[${index}]`);
        validateRedactionPattern(pattern as unknown as RedactionPatternConfig, index);
      }
    }
  }

  const promotion = optionalConfigSection(value, "promotion");
  if (promotion) validatePromotionConfig(promotion);

  const sync = value.sync;
  if (sync !== undefined) {
    if (!isConfigRecord(sync)) throw new Error("sync must be an object");
    assertKnownKeys(sync, new Set(["autoSyncOnServerStart", "shareLocalLayers", "conflictPolicy"]), "sync");
    if (sync.autoSyncOnServerStart !== undefined && typeof sync.autoSyncOnServerStart !== "boolean") {
      throw new Error("sync.autoSyncOnServerStart must be a boolean");
    }
    if (sync.shareLocalLayers !== undefined && !["durable", "all", "none"].includes(String(sync.shareLocalLayers))) {
      throw new Error("sync.shareLocalLayers must be durable, all, or none");
    }
    if (sync.conflictPolicy !== undefined && !["merge", "ask"].includes(String(sync.conflictPolicy))) {
      throw new Error("sync.conflictPolicy must be merge or ask");
    }
  }
  const extraction = optionalConfigSection(value, "extraction");
  if (extraction) {
    assertKnownKeys(extraction, new Set(Object.keys(DEFAULT_EXTRACTION_CONFIG)), "extraction");
    for (const [key, setting] of Object.entries(extraction)) {
      if (!Number.isInteger(setting) || (setting as number) < 0) throw new Error(`extraction.${key} must be a non-negative integer`);
    }
  }
  const review = optionalConfigSection(value, "review");
  if (review) {
    assertKnownKeys(review, new Set(["automatic"]), "review");
    const automatic = review.automatic;
    if (automatic !== undefined) {
      if (!isConfigRecord(automatic)) throw new Error("review.automatic must be an object");
      assertKnownKeys(automatic, new Set(Object.keys(DEFAULT_AUTOMATIC_REVIEW_CONFIG)), "review.automatic");
      if (automatic.enabled !== undefined && typeof automatic.enabled !== "boolean") throw new Error("review.automatic.enabled must be a boolean");
      for (const key of ["dailyItems", "tokenBudget"] as const) {
        if (automatic[key] !== undefined && !isPositiveInteger(automatic[key])) throw new Error(`review.automatic.${key} must be a positive integer`);
      }
      if (automatic.applyVerdicts !== undefined && (!Array.isArray(automatic.applyVerdicts) ||
        automatic.applyVerdicts.some((verdict) => !["current", "obsolete", "low_value"].includes(String(verdict))))) {
        throw new Error("review.automatic.applyVerdicts may contain only current, obsolete, and low_value");
      }
    }
  }
  const retention = optionalConfigSection(value, "retention");
  if (retention) validateRetentionConfig(retention);
}

export const DEFAULT_AUTOMATIC_REVIEW_CONFIG: AutomaticReviewConfig = {
  enabled: true,
  dailyItems: 100,
  tokenBudget: 1_500_000,
  applyVerdicts: ["current", "obsolete"]
};

/** The effective automatic-review settings, including for configs built without the section. */
export function automaticReviewPolicy(config: Pick<ProjectConfig, "review">): AutomaticReviewConfig {
  return { ...DEFAULT_AUTOMATIC_REVIEW_CONFIG, ...(config.review?.automatic ?? {}) };
}

export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  conversationQuietMinutes: 10,
  conversationMaxWaitMinutes: 60,
  maxDeltaChunks: 200,
  overlapChunks: 6,
  relatedMemories: 20
};

/** The effective extraction settings, including for configs built without the section. */
export function extractionPolicy(config: Pick<ProjectConfig, "extraction">): ExtractionConfig {
  return { ...DEFAULT_EXTRACTION_CONFIG, ...(config.extraction ?? {}) };
}

function validateGlobalConfigFile(value: unknown): void {
  if (!isConfigRecord(value)) throw new Error("Global config must be an object");
  assertKnownKeys(
    value,
    new Set(["defaults", "profiles", "sources", "extractor", "investigator", "embeddings", "globalRules", "ai"]),
    "global config"
  );
  if (value.ai !== undefined) validateAiSettings(value.ai, "ai", true);
  if (value.globalRules !== undefined) validateProjectConfigFile({ globalRules: value.globalRules });

  if (value.defaults !== undefined) {
    if (!isConfigRecord(value.defaults)) throw new Error("global.defaults must be an object");
    assertKnownKeys(value.defaults, new Set(["extractorProfile", "investigatorProfile"]), "global.defaults");
    for (const key of ["extractorProfile", "investigatorProfile"] as const) {
      if (value.defaults[key] !== undefined && !isNonemptyString(value.defaults[key])) {
        throw new Error(`global.defaults.${key} must be a nonempty string`);
      }
    }
  }

  if (value.profiles !== undefined) {
    if (!isConfigRecord(value.profiles)) throw new Error("global.profiles must be an object");
    for (const [name, profile] of Object.entries(value.profiles)) {
      if (!isConfigRecord(profile)) throw new Error(`global.profiles.${name} must be an object`);
    }
  }

  if (value.sources !== undefined) {
    if (!isConfigRecord(value.sources)) throw new Error("global.sources must be an object");
    assertKnownKeys(value.sources, new Set(["codex", "claude"]), "global.sources");
    for (const adapter of ["codex", "claude"] as const) {
      const source = value.sources[adapter];
      if (source === undefined) continue;
      if (!isConfigRecord(source)) throw new Error(`global.sources.${adapter} must be an object`);
      assertKnownKeys(
        source,
        adapter === "codex"
          ? new Set(["enabled", "roots", "includeDefaultRoots", "projectOnly"])
          : new Set(["enabled", "roots", "projectOnly"]),
        `global.sources.${adapter}`
      );
      if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
        throw new Error(`global.sources.${adapter}.enabled must be a boolean`);
      }
      if (source.projectOnly !== undefined && typeof source.projectOnly !== "boolean") {
        throw new Error(`global.sources.${adapter}.projectOnly must be a boolean`);
      }
      if (adapter === "codex" && source.includeDefaultRoots !== undefined && typeof source.includeDefaultRoots !== "boolean") {
        throw new Error("global.sources.codex.includeDefaultRoots must be a boolean");
      }
      if (source.roots !== undefined) {
        if (!Array.isArray(source.roots) || source.roots.some(root => !isNonemptyString(root))) {
          throw new Error(`global.sources.${adapter}.roots must be an array of nonempty strings`);
        }
      }
    }
  }

  validateProjectConfigFile({
    ...(value.extractor !== undefined ? { extractor: value.extractor } : {}),
    ...(value.investigator !== undefined ? { investigator: value.investigator } : {}),
    ...(value.embeddings !== undefined ? { embeddings: value.embeddings } : {})
  });
}

const AI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Checks AI settings; a project override may only choose models, never define connections or budgets. */
function validateAiSettings(value: unknown, path: string, global: boolean): void {
  if (!isConfigRecord(value)) throw new Error(`${path} must be an object`);
  assertKnownKeys(value, new Set(global ? ["connections", "tiers", "jobs", "budgets"] : ["tiers", "jobs"]), path);
  const connections = value.connections;
  if (connections !== undefined) {
    if (!isConfigRecord(connections)) throw new Error(`${path}.connections must be an object`);
    for (const [id, connection] of Object.entries(connections)) {
      const at = `${path}.connections.${id}`;
      if (!AI_ID.test(id)) throw new Error(`${at}: connection ids use lowercase letters, digits and hyphens`);
      if (!isConfigRecord(connection)) throw new Error(`${at} must be an object`);
      assertKnownKeys(connection, new Set(["kind", "label", "baseUrl", "apiKeyEnv", "workspaceIdEnv", "regionEnv", "workspaceId", "region", "keyUpdatedAt", "keySavedToEnv", "dataCollection"]), at);
      if (!isAiConnectionKind(connection.kind)) throw new Error(`${at}.kind is not a supported provider`);
      if (connection.label !== undefined && (typeof connection.label !== "string" || connection.label.length > 80)) throw new Error(`${at}.label must be at most 80 characters`);
      if (connection.baseUrl !== undefined && !isValidEmbeddingBaseUrl(connection.baseUrl)) throw new Error(`${at}.baseUrl must be an HTTP(S) URL without credentials`);
      if (connection.kind === "openai-compatible" && connection.baseUrl === undefined) throw new Error(`${at}.baseUrl is required for a custom endpoint`);
      for (const key of ["apiKeyEnv", "workspaceIdEnv", "regionEnv"] as const) {
        if (connection[key] !== undefined && (typeof connection[key] !== "string" || !ENV_NAME.test(connection[key] as string))) throw new Error(`${at}.${key} must be an environment variable name`);
      }
      for (const key of ["workspaceId", "region", "keyUpdatedAt"] as const) {
        if (connection[key] !== undefined && (!isNonemptyString(connection[key]) || (connection[key] as string).length > 200)) throw new Error(`${at}.${key} must be a short string`);
      }
      if (connection.keySavedToEnv !== undefined && connection.keySavedToEnv !== true) throw new Error(`${at}.keySavedToEnv must be true when set`);
      if (connection.dataCollection !== undefined && connection.dataCollection !== "allow" && connection.dataCollection !== "deny") throw new Error(`${at}.dataCollection must be allow or deny`);
    }
  }
  const knownConnection = (id: unknown) => !global || (isConfigRecord(connections) && typeof id === "string" && Object.prototype.hasOwnProperty.call(connections, id));
  const validateChoice = (choice: unknown, at: string, allowTier: boolean): void => {
    if (!isConfigRecord(choice)) throw new Error(`${at} must be an object`);
    if (allowTier && choice.tier !== undefined) {
      assertKnownKeys(choice, new Set(["tier"]), at);
      if (choice.tier !== "fast" && choice.tier !== "smart") throw new Error(`${at}.tier must be fast or smart`);
      return;
    }
    assertKnownKeys(choice, new Set(["connection", "model", "maxTokens"]), at);
    if (!isNonemptyString(choice.connection) || !knownConnection(choice.connection)) throw new Error(`${at}.connection must name a configured connection`);
    if (!isNonemptyString(choice.model) || choice.model.length > 200) throw new Error(`${at}.model must be a model id`);
    if (choice.maxTokens !== undefined && !isPositiveInteger(choice.maxTokens)) throw new Error(`${at}.maxTokens must be a positive integer`);
  };
  if (value.tiers !== undefined) {
    if (!isConfigRecord(value.tiers)) throw new Error(`${path}.tiers must be an object`);
    assertKnownKeys(value.tiers, new Set(["fast", "smart"]), `${path}.tiers`);
    for (const tier of ["fast", "smart"] as const) if (value.tiers[tier] !== undefined) validateChoice(value.tiers[tier], `${path}.tiers.${tier}`, false);
  }
  if (value.jobs !== undefined) {
    if (!isConfigRecord(value.jobs)) throw new Error(`${path}.jobs must be an object`);
    assertKnownKeys(value.jobs, new Set(AI_JOBS), `${path}.jobs`);
    for (const [job, choice] of Object.entries(value.jobs)) validateChoice(choice, `${path}.jobs.${job}`, true);
  }
  if (value.budgets !== undefined) {
    if (!isConfigRecord(value.budgets)) throw new Error(`${path}.budgets must be an object`);
    assertKnownKeys(value.budgets, new Set(["backgroundDailyTokens"]), `${path}.budgets`);
    const limit = value.budgets.backgroundDailyTokens;
    if (limit !== undefined && limit !== null && (!isPositiveInteger(limit) || limit > 10_000_000_000)) throw new Error(`${path}.budgets.backgroundDailyTokens must be a positive integer or null`);
  }
}

function validatePromotionConfig(promotion: Record<string, unknown>): void {
  assertKnownKeys(
    promotion,
    new Set(["confidenceThreshold", "requireCommitAndConversation", "minSourceCategories", "automatic"]),
    "promotion"
  );
  if (promotion.confidenceThreshold !== undefined && !isUnitInterval(promotion.confidenceThreshold)) {
    throw new Error("promotion.confidenceThreshold must be a number between 0 and 1");
  }
  if (promotion.requireCommitAndConversation !== undefined && typeof promotion.requireCommitAndConversation !== "boolean") {
    throw new Error("promotion.requireCommitAndConversation must be a boolean");
  }
  if (promotion.minSourceCategories !== undefined && !isPositiveInteger(promotion.minSourceCategories)) {
    throw new Error("promotion.minSourceCategories must be a positive integer");
  }
  if (promotion.automatic === undefined) return;
  if (!isConfigRecord(promotion.automatic)) throw new Error("promotion.automatic must be an object");
  const automatic = promotion.automatic;
  assertKnownKeys(
    automatic,
    new Set(["enabled", "mode", "minScore", "mergedBranches", "deviceMemories", "coreCandidates", "singleSourceMinConfidence"]),
    "promotion.automatic"
  );
  for (const flag of ["enabled", "mergedBranches", "deviceMemories", "coreCandidates"] as const) {
    if (automatic[flag] !== undefined && typeof automatic[flag] !== "boolean") {
      throw new Error(`promotion.automatic.${flag} must be a boolean`);
    }
  }
  if (automatic.mode !== undefined && automatic.mode !== "conservative") {
    throw new Error("promotion.automatic.mode must be conservative");
  }
  if (automatic.minScore !== undefined && !isUnitInterval(automatic.minScore)) {
    throw new Error("promotion.automatic.minScore must be a number between 0 and 1");
  }
  if (automatic.singleSourceMinConfidence !== undefined && !isUnitInterval(automatic.singleSourceMinConfidence)) {
    throw new Error("promotion.automatic.singleSourceMinConfidence must be a number between 0 and 1");
  }
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function optionalConfigSection(
  config: Record<string, unknown>,
  name: "retrieval" | "embeddings" | "privacy" | "retention" | "promotion" | "globalRules" | "extraction" | "review"
): Record<string, unknown> | undefined {
  const value = config[name];
  if (value === undefined) return undefined;
  if (!isConfigRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function validateRetentionConfig(retention: Record<string, unknown>): void {
  assertKnownKeys(retention, new Set(["migrationBackups", "sources", "overrides", "layers", "artifacts"]), "retention");
  if (retention.migrationBackups !== undefined && !isNonNegativeInteger(retention.migrationBackups)) {
    throw new Error("retention.migrationBackups must be a non-negative integer");
  }
  if (retention.layers !== undefined) validateLayerRetentionConfig(retention.layers);
  if (retention.artifacts !== undefined) validateArtifactRetentionConfig(retention.artifacts);
  if (retention.sources === undefined) return;
  if (!isConfigRecord(retention.sources)) throw new Error("retention.sources must be an object");
  assertKnownKeys(retention.sources, new Set(["git", "codex", "claude", "manual"]), "retention.sources");
  for (const adapter of ["git", "codex", "claude", "manual"] as const) {
    const policy = retention.sources[adapter];
    if (policy === undefined) continue;
    if (!isConfigRecord(policy)) throw new Error(`retention.sources.${adapter} must be an object`);
    assertKnownKeys(policy, new Set(["maxAgeDays"]), `retention.sources.${adapter}`);
    if (policy.maxAgeDays !== undefined && policy.maxAgeDays !== null && !isPositiveInteger(policy.maxAgeDays)) {
      throw new Error(`retention.sources.${adapter}.maxAgeDays must be null or a positive integer`);
    }
  }
  if (retention.overrides !== undefined) {
    if (!Array.isArray(retention.overrides)) throw new Error("retention.overrides must be an array");
    for (const [index, override] of retention.overrides.entries()) {
      if (!isConfigRecord(override)) throw new Error(`retention.overrides[${index}] must be an object`);
      assertKnownKeys(override, new Set(["sourceId", "maxAgeDays"]), `retention.overrides[${index}]`);
      if (typeof override.sourceId !== "string" || override.sourceId.trim() === "") {
        throw new Error(`retention.overrides[${index}].sourceId must be a non-empty string`);
      }
      if (override.maxAgeDays !== null && !isPositiveInteger(override.maxAgeDays)) {
        throw new Error(`retention.overrides[${index}].maxAgeDays must be null or a positive integer`);
      }
    }
  }
}

function validateArtifactRetentionConfig(value: unknown): void {
  if (!isConfigRecord(value)) throw new Error("retention.artifacts must be an object");
  assertKnownKeys(value, new Set(["logs", "projectSummaryBackups", "recoveryBackups", "cloudHandles"]), "retention.artifacts");
  if (value.logs !== undefined) {
    if (!isConfigRecord(value.logs)) throw new Error("retention.artifacts.logs must be an object");
    assertKnownKeys(value.logs, new Set(["maxBytes", "maxFiles"]), "retention.artifacts.logs");
    if (value.logs.maxBytes !== undefined && !isPositiveInteger(value.logs.maxBytes)) {
      throw new Error("retention.artifacts.logs.maxBytes must be a positive integer");
    }
    if (value.logs.maxFiles !== undefined && !isNonNegativeInteger(value.logs.maxFiles)) {
      throw new Error("retention.artifacts.logs.maxFiles must be a non-negative integer");
    }
  }
  if (value.projectSummaryBackups !== undefined) {
    if (!isConfigRecord(value.projectSummaryBackups)) throw new Error("retention.artifacts.projectSummaryBackups must be an object");
    assertKnownKeys(value.projectSummaryBackups, new Set(["maxFiles"]), "retention.artifacts.projectSummaryBackups");
    if (value.projectSummaryBackups.maxFiles !== undefined && !isNonNegativeInteger(value.projectSummaryBackups.maxFiles)) {
      throw new Error("retention.artifacts.projectSummaryBackups.maxFiles must be a non-negative integer");
    }
  }
  if (value.recoveryBackups !== undefined) {
    if (!isConfigRecord(value.recoveryBackups)) throw new Error("retention.artifacts.recoveryBackups must be an object");
    assertKnownKeys(value.recoveryBackups, new Set(["maxFiles", "minAgeDays"]), "retention.artifacts.recoveryBackups");
    if (value.recoveryBackups.maxFiles !== undefined && !isNonNegativeInteger(value.recoveryBackups.maxFiles)) {
      throw new Error("retention.artifacts.recoveryBackups.maxFiles must be a non-negative integer");
    }
    if (value.recoveryBackups.minAgeDays !== undefined && !isNonNegativeInteger(value.recoveryBackups.minAgeDays)) {
      throw new Error("retention.artifacts.recoveryBackups.minAgeDays must be a non-negative integer");
    }
  }
  if (value.cloudHandles !== undefined) {
    if (!isConfigRecord(value.cloudHandles)) throw new Error("retention.artifacts.cloudHandles must be an object");
    assertKnownKeys(value.cloudHandles, new Set(["reapStale"]), "retention.artifacts.cloudHandles");
    if (value.cloudHandles.reapStale !== undefined && typeof value.cloudHandles.reapStale !== "boolean") {
      throw new Error("retention.artifacts.cloudHandles.reapStale must be a boolean");
    }
  }
}

function validateLayerRetentionConfig(value: unknown): void {
  if (!isConfigRecord(value)) throw new Error("retention.layers must be an object");
  assertKnownKeys(value, new Set(["enabled", "graceDays", "branch", "device"]), "retention.layers");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("retention.layers.enabled must be a boolean");
  }
  if (value.graceDays !== undefined && !isNonNegativeInteger(value.graceDays)) {
    throw new Error("retention.layers.graceDays must be a non-negative integer");
  }
  if (value.branch !== undefined) {
    if (!isConfigRecord(value.branch)) throw new Error("retention.layers.branch must be an object");
    assertKnownKeys(value.branch, new Set(["onDeleted", "onMerged", "maxIdleDays"]), "retention.layers.branch");
    for (const key of ["onDeleted", "onMerged"] as const) {
      const action = value.branch[key];
      if (action !== undefined && action !== "archive" && action !== "keep") {
        throw new Error(`retention.layers.branch.${key} must be archive or keep`);
      }
    }
    assertOptionalIdleDays(value.branch.maxIdleDays, "retention.layers.branch.maxIdleDays");
  }
  if (value.device !== undefined) {
    if (!isConfigRecord(value.device)) throw new Error("retention.layers.device must be an object");
    assertKnownKeys(value.device, new Set(["maxIdleDays"]), "retention.layers.device");
    assertOptionalIdleDays(value.device.maxIdleDays, "retention.layers.device.maxIdleDays");
  }
}

function assertOptionalIdleDays(value: unknown, path: string): void {
  if (value !== undefined && value !== null && !isPositiveInteger(value)) {
    throw new Error(`${path} must be null or a positive integer`);
  }
}

function assertKnownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path} contains unknown key: ${unknown}`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidEmbeddingBaseUrl(value: unknown): value is string {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function resolveProviderConfig(
  kind: "extractor",
  defaults: ExtractorConfig,
  globalConfig: GlobalConfigFile,
  overrides: ExtractorConfigInput | undefined
): ExtractorConfig;
function resolveProviderConfig(
  kind: "investigator",
  defaults: InvestigatorConfig,
  globalConfig: GlobalConfigFile,
  overrides: InvestigatorConfigInput | undefined
): InvestigatorConfig;
function resolveProviderConfig<T extends ExtractorConfig | InvestigatorConfig>(
  kind: ProviderKind,
  defaults: T,
  globalConfig: GlobalConfigFile,
  overrides: ExtractorConfigInput | InvestigatorConfigInput | undefined
): T {
  const merged: Record<string, unknown> = { ...defaults };
  let providerLayer = Object.prototype.hasOwnProperty.call(defaults, "provider") ? 0 : -1;
  let baseUrlLayer = Object.prototype.hasOwnProperty.call(defaults, "baseUrl") ? 0 : -1;

  const applyLayer = (values: Record<string, unknown> | undefined, layer: number, providerOnly: boolean): void => {
    if (!values) return;
    const keys = providerOnly ? PROVIDER_KEYS : Object.keys(values);
    for (const key of keys) {
      if (key === "profile") continue;
      if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
      const value = values[key];
      if (value === undefined) continue;
      merged[key] = value;
      if (key === "provider") providerLayer = layer;
      if (key === "baseUrl") baseUrlLayer = layer;
    }
  };

  const defaultProfileName =
    kind === "extractor" ? globalConfig.defaults?.extractorProfile : globalConfig.defaults?.investigatorProfile;
  applyLayer(readProviderProfile(globalConfig, defaultProfileName, kind), 1, true);
  applyLayer(readProviderProfile(globalConfig, overrides?.profile, kind), 2, true);
  applyLayer(overrides as Record<string, unknown> | undefined, 3, false);

  if (merged.provider === "anthropic-aws" && baseUrlLayer < providerLayer) {
    delete merged.baseUrl;
  }

  return merged as T;
}

/**
 * Legacy profiles resolve first; an `ai` section then decides every job's model, with this
 * project's `ai` overrides applied last.
 */
function resolveProjectModels(
  defaults: ProjectConfig,
  globalConfig: GlobalConfigFile,
  parsed: ProjectConfigFile,
  projectOnly: ProjectConfigFile,
  consent: RemoteModelConsent
): Pick<ProjectConfig, "extractor" | "investigator" | "models" | "aiBudget"> {
  const legacyExtractor = withConsentRequirement(
    resolveProviderConfig("extractor", defaults.extractor, globalConfig, parsed.extractor),
    providerChosenByUser("extractor", globalConfig, parsed.extractor),
    consent
  );
  const legacyInvestigator = withConsentRequirement(
    resolveProviderConfig("investigator", defaults.investigator, globalConfig, parsed.investigator),
    providerChosenByUser("investigator", globalConfig, parsed.investigator),
    consent
  );
  const legacy = legacyJobModels(legacyExtractor, legacyInvestigator);
  const models = resolveAiJobModels(globalConfig.ai, parsed.ai, legacy);
  // Provider settings written in this project's own config files still win over the global AI settings.
  const setsProvider = (block: ExtractorConfigInput | InvestigatorConfigInput | undefined) =>
    Boolean(block && (block.profile !== undefined || PROVIDER_KEYS.some(key => block[key] !== undefined)));
  if (hasAiSettings(globalConfig.ai)) {
    if (setsProvider(projectOnly.extractor)) models.extraction = { ...legacy.extraction, source: "project-override" };
    if (setsProvider(projectOnly.investigator)) {
      for (const job of ["review", "wording", "summary", "investigator", "consolidation"] as const) models[job] = { ...legacy[job], source: "project-override" };
    }
  }
  const budget = globalConfig.ai?.budgets?.backgroundDailyTokens;
  return {
    extractor: models.extraction.source === "legacy" ? legacyExtractor : modelFields(models.extraction),
    investigator: jobInvestigatorConfig({ models, extractor: legacyExtractor, investigator: legacyInvestigator }, "investigator"),
    models,
    aiBudget: { backgroundDailyTokens: budget === null ? null : budget ?? DEFAULT_BACKGROUND_DAILY_TOKENS }
  };
}

interface RemoteModelConsent {
  allowRemoteModels: boolean;
  /** Variables given a value in Butler's own .env files; a key put there was meant for Butler. */
  butlerEnvKeys: ReadonlySet<string>;
}

/**
 * Marks the built-in default model when it would run on a key that merely sits in the shell
 * environment: nobody chose to send this project's transcripts and diffs to that provider.
 */
function withConsentRequirement<T extends ExtractorConfig | InvestigatorConfig>(model: T, chosenByUser: boolean, consent: RemoteModelConsent): T {
  const requiresConsent = !chosenByUser
    && !consent.allowRemoteModels
    && !consent.butlerEnvKeys.has(model.apiKeyEnv);
  return requiresConsent ? { ...model, requiresConsent: true } : model;
}

/** Whether a person picked this provider, rather than the built-in default or a generated profile. */
function providerChosenByUser(kind: ProviderKind, globalConfig: GlobalConfigFile, overrides: ExtractorConfigInput | InvestigatorConfigInput | undefined): boolean {
  if (overrides && (overrides.profile !== undefined || PROVIDER_KEYS.some(key => overrides[key] !== undefined))) return true;
  const name = kind === "extractor" ? globalConfig.defaults?.extractorProfile : globalConfig.defaults?.investigatorProfile;
  const profile = name ? globalConfig.profiles?.[name] : undefined;
  if (!name || !profile) return false;
  // Older releases generated these profiles with other models, so only a changed destination counts.
  const generated = defaultGlobalConfigFile().profiles?.[name];
  return !generated || (["provider", "baseUrl", "apiKeyEnv"] as const).some(key => profile[key] !== generated[key]);
}

function readProviderProfile(
  config: GlobalConfigFile,
  profileName: string | undefined,
  kind: ProviderKind
): ProviderProfileConfig | undefined {
  if (!profileName) return undefined;
  const profile = config.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Unknown Code Butler provider profile "${profileName}" for ${kind}`);
  }
  return profile;
}

function mergeConfigFiles(shared: ProjectConfigFile, local: ProjectConfigFile): ProjectConfigFile {
  return deepMerge(shared, local) as ProjectConfigFile;
}

function readConfigObject(path: string): ConfigObject {
  const raw = readFileSync(path, "utf8").trim();
  const parsed = raw.length > 0 ? JSON.parse(raw) : {};
  if (!isConfigRecord(parsed)) throw new Error(`Config file must be an object: ${path}`);
  return parsed;
}

function writeConfigObject(path: string, value: ConfigObject): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepMerge(left: unknown, right: unknown): unknown {
  if (!isConfigRecord(left) || !isConfigRecord(right)) return right ?? left;
  const result: ConfigObject = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) continue;
    result[key] = key in result && isConfigRecord(result[key]) && isConfigRecord(value)
      ? deepMerge(result[key], value)
      : value;
  }
  return result;
}

function localOnlyConfigPaths(config: ConfigObject): string[] {
  const paths = [
    "sources.git.repoPath",
    "sources.git.hookInstall",
    "sources.codex.roots",
    "sources.codex.includeDefaultRoots",
    "sources.claude.roots",
    "extractor",
    "investigator",
    "embeddings",
    "ai"
  ];
  return paths.filter((path) => getNested(config, path) !== undefined);
}

function localOnlyReason(path: string): ConfigPortabilityIssue["reason"] {
  if (path.endsWith(".repoPath") || path.endsWith(".roots")) return "device_local_path";
  if (path === "extractor" || path === "investigator" || path === "embeddings" || path === "ai") return "provider_runtime_setting";
  return "device_local_source_setting";
}

function getNested(root: ConfigObject, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isConfigRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setNested(root: ConfigObject, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isConfigRecord(current[segment])) current[segment] = {};
    current = current[segment] as ConfigObject;
  }
  current[segments.at(-1)!] = cloneConfig(value);
}

function deleteNested(root: ConfigObject, path: string): void {
  const segments = path.split(".");
  const parents: Array<{ target: ConfigObject; key: string }> = [];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isConfigRecord(current[segment])) return;
    parents.push({ target: current, key: segment });
    current = current[segment] as ConfigObject;
  }
  delete current[segments.at(-1)!];
  for (const parent of parents.reverse()) {
    const child = parent.target[parent.key];
    if (isConfigRecord(child) && Object.keys(child).length === 0) delete parent.target[parent.key];
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveRootedPath(rootDir: string, pathValue: string): string {
  if (isAbsolute(pathValue)) return pathValue;
  return resolve(rootDir, pathValue);
}

function defaultCodexRoots(home: string): string[] {
  return [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
}

function normalizeCodexRoots(
  rootDir: string,
  codex: Partial<ProjectConfig["sources"]["codex"]>,
  defaultRoots: string[]
): string[] {
  const configuredRoots = (codex.roots ?? defaultRoots).map((root) => resolveRootedPath(rootDir, root));
  const includeDefaultRoots = codex.includeDefaultRoots ?? true;
  const roots = includeDefaultRoots ? [...defaultRoots, ...configuredRoots] : configuredRoots;
  return [...new Set(roots)];
}

function loadGlobalConfig(): GlobalConfigFile {
  const configPath = join(globalConfigDir(), "config.json");
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  const parsed: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
  validateGlobalConfigFile(parsed);
  return parsed as GlobalConfigFile;
}

function globalProjectConfig(config: GlobalConfigFile): ProjectConfigFile {
  return {
    ...(config.globalRules ? { globalRules: config.globalRules } : {}),
    ...(config.sources ? { sources: config.sources } : {}),
    ...(config.extractor ? { extractor: config.extractor } : {}),
    ...(config.investigator ? { investigator: config.investigator } : {}),
    ...(config.embeddings ? { embeddings: config.embeddings } : {})
  };
}

function loadGlobalEnv(): Set<string> {
  return loadEnvFile(join(globalConfigDir(), ".env"));
}

function loadProjectEnv(rootDir: string): Set<string> {
  return loadEnvFile(join(rootDir, ".code-butler", ".env"));
}

/** Returns the names the file gives a value, whether or not the environment already had one. */
function loadEnvFile(envPath: string): Set<string> {
  const defined = new Set<string>();
  if (!existsSync(envPath)) return defined;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (value.trim()) defined.add(key);
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return defined;
}

/**
 * Sets (or with undefined, removes) one variable in the global .env file, keeping every other
 * line. Returns the value it replaced. Written atomically and readable only by this user.
 */
export function setGlobalEnvValue(name: string, value: string | undefined): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${name} is not an environment variable name`);
  if (value !== undefined && (!value || /[\s"']/.test(value))) throw new Error("That value cannot be written to the .env file.");
  const globalDir = globalConfigDir();
  mkdirSync(globalDir, { recursive: true });
  ensureEnvGitignore(globalDir);
  const envPath = join(globalDir, ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  let previous: string | undefined;
  const kept = lines.filter(line => {
    const parsed = parseEnvLine(line);
    if (parsed?.[0] !== name) return true;
    previous = parsed[1];
    return false;
  });
  while (kept.length && kept.at(-1) === "") kept.pop();
  if (value !== undefined) kept.push(`${name}=${value}`);
  if (previous === undefined && value === undefined) return undefined;
  const temporary = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, kept.length ? `${kept.join("\n")}\n` : "");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, envPath); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  return previous;
}

function ensureProjectGitignore(rootDir: string): void {
  const gitignorePath = join(rootDir, ".code-butler", ".gitignore");
  if (existsSync(gitignorePath) && readFileSync(gitignorePath, "utf8") !== LEGACY_ENV_ONLY_IGNORE) return;
  writeFileSync(gitignorePath, PROJECT_CODE_BUTLER_IGNORE);
}

function ensureEnvGitignore(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) return;
  writeFileSync(gitignorePath, LEGACY_ENV_ONLY_IGNORE);
}

function ensureProjectEnvExample(rootDir: string): void {
  const envExamplePath = join(rootDir, ".code-butler", ".env.example");
  if (existsSync(envExamplePath)) return;
  writeFileSync(
    envExamplePath,
    [
      "# Project-local Code Butler credential overrides",
      "# Prefer one-time global credentials in ~/.config/code-butler/.env.",
      "# Copy this file to .code-butler/.env only when this project needs different provider credentials.",
      "",
      "# OpenAI-compatible providers, including OpenAI, OpenRouter, LiteLLM, Ollama, and LM Studio.",
      "OPENAI_API_KEY=",
      "OPENROUTER_API_KEY=",
      "LITELLM_KEY=",
      "",
      "# Claude Platform on AWS direct provider (provider: anthropic-aws).",
      "ANTHROPIC_AWS_API_KEY=",
      "ANTHROPIC_AWS_WORKSPACE_ID=",
      "AWS_REGION=us-east-1",
      ""
    ].join("\n")
  );
}

function ensureProjectLocalConfig(rootDir: string): void {
  const localConfigPath = projectLocalConfigPath(rootDir);
  if (existsSync(localConfigPath)) return;
  writeFileSync(localConfigPath, JSON.stringify(defaultLocalConfigFile(), null, 2) + "\n");
}

function defaultLocalConfigFile(): ProjectConfigFile {
  const home = homedir();
  return {
    sources: {
      git: {
        repoPath: ".",
        hookInstall: false
      },
      codex: {
        roots: defaultCodexRoots(home),
        includeDefaultRoots: true
      },
      claude: {
        roots: [join(home, ".claude", "projects")]
      }
    }
  };
}

function ensureGlobalEnvExample(globalDir: string): void {
  const envExamplePath = join(globalDir, ".env.example");
  if (existsSync(envExamplePath)) return;
  writeFileSync(
    envExamplePath,
    [
      "# Global Code Butler credentials",
      "# Copy this file to ~/.config/code-butler/.env and fill in only the providers you use.",
      "# Set CODE_BUTLER_HOME to use a different global config directory.",
      "",
      "# OpenAI-compatible providers, including OpenAI, OpenRouter, LiteLLM, Ollama, and LM Studio.",
      "OPENAI_API_KEY=",
      "OPENROUTER_API_KEY=",
      "LITELLM_KEY=",
      "",
      "# Claude Platform on AWS direct provider (provider: anthropic-aws).",
      "ANTHROPIC_AWS_API_KEY=",
      "ANTHROPIC_AWS_WORKSPACE_ID=",
      "AWS_REGION=us-east-1",
      ""
    ].join("\n")
  );
}

function defaultGlobalConfigFile(): GlobalConfigFile {
  const home = homedir();
  return {
    defaults: {
      extractorProfile: "cheap",
      investigatorProfile: "smart"
    },
    sources: {
      codex: {
        roots: defaultCodexRoots(home),
        includeDefaultRoots: true
      },
      claude: {
        roots: [join(home, ".claude", "projects")]
      }
    },
    profiles: {
      cheap: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 1200
      },
      smart: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 2500
      }
    }
  };
}

function ensureProjectConfigExamples(rootDir: string): void {
  const examplesPath = join(rootDir, ".code-butler", "config.examples.json");
  if (existsSync(examplesPath)) return;
  writeFileSync(examplesPath, JSON.stringify(defaultConfigExamplesFile(), null, 2));
}

function defaultConfigExamplesFile(): Record<string, unknown> {
  return {
    note:
      "Examples only. Copy the blocks you want into config.json. The extractor and investigator are independent from embeddings and may use different providers, models, base URLs, and token budgets.",
    localEmbeddings: {
      description: "Optional local embeddings through an OpenAI-compatible loopback service such as Ollama.",
      retrieval: { mode: "hybrid", rrfK: 60 },
      embeddings: {
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "nomic-embed-text",
        batchSize: 16
      },
      privacy: { allowRemoteEmbeddings: false }
    },
    privacyControls: {
      description: "Project-specific redaction and retention examples. Replace example patterns before use. allowRemoteModels lets the built-in default model run on a key found only in the shell environment; set it in config.local.json.",
      privacy: {
        allowRemoteModels: false,
        redactionPatterns: [
          { name: "internal token", kind: "regex", pattern: "INTERNAL-[A-Za-z0-9]+" },
          { name: "literal password", kind: "literal", pattern: "replace-this-example" }
        ]
      },
      retention: {
        migrationBackups: 2,
        sources: {
          git: { maxAgeDays: null },
          codex: { maxAgeDays: 90 },
          claude: { maxAgeDays: 90 },
          manual: { maxAgeDays: null }
        },
        overrides: []
      }
    },
    openaiCompatible: {
      description: "OpenAI-compatible /chat/completions providers such as OpenAI.",
      extractor: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 1200
      },
      investigator: {
        enabled: true,
        mode: "native-rlm",
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        apiKeyEnv: "OPENAI_API_KEY",
        maxTokens: 2500,
        maxDepth: 3,
        maxSteps: 18,
        maxBranching: 2,
        topKPerSearch: 5,
        evidenceThreshold: 0.75,
        returnTrace: true
      }
    },
    claudeAnthropicAws: {
      description: "Direct Claude Platform on AWS usage through Code Butler's anthropic-aws provider.",
      extractor: {
        provider: "anthropic-aws",
        model: "claude-haiku-4-5-20251001",
        apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "AWS_REGION",
        maxTokens: 1200
      },
      investigator: {
        enabled: true,
        mode: "native-rlm",
        provider: "anthropic-aws",
        model: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
        workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
        regionEnv: "AWS_REGION",
        maxTokens: 2500,
        maxDepth: 3,
        maxSteps: 18,
        maxBranching: 2,
        topKPerSearch: 5,
        evidenceThreshold: 0.75,
        returnTrace: true
      }
    },
    claudeViaOpenAiCompatibleProxy: {
      description: "Claude through an OpenAI-compatible proxy such as LiteLLM or OpenRouter.",
      extractor: {
        provider: "openai-compatible",
        baseUrl: "http://localhost:4000",
        model: "claude-haiku-for-extraction",
        apiKeyEnv: "LITELLM_KEY",
        maxTokens: 1200
      },
      investigator: {
        enabled: true,
        mode: "native-rlm",
        provider: "openai-compatible",
        baseUrl: "http://localhost:4000",
        model: "claude-sonnet-for-investigation",
        apiKeyEnv: "LITELLM_KEY",
        maxTokens: 2500,
        maxDepth: 3,
        maxSteps: 18,
        maxBranching: 2,
        topKPerSearch: 5,
        evidenceThreshold: 0.75,
        returnTrace: true
      }
    }
  };
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match?.[1]) return undefined;
  return [match[1], unquoteEnvValue(match[2] ?? "")];
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
