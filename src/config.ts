import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ExtractorConfig, ExtractorConfigInput, InvestigatorConfig, InvestigatorConfigInput, ProjectConfig, RedactionPatternConfig } from "./types.js";
import { validateRedactionPattern } from "./privacy/policy.js";

interface ProjectConfigFile {
  sources?: {
    git?: Partial<ProjectConfig["sources"]["git"]>;
    codex?: Partial<ProjectConfig["sources"]["codex"]>;
    claude?: Partial<ProjectConfig["sources"]["claude"]>;
  };
  extractor?: ExtractorConfigInput;
  investigator?: InvestigatorConfigInput;
  promotion?: Partial<ProjectConfig["promotion"]>;
  sync?: Partial<ProjectConfig["sync"]>;
  retrieval?: Partial<ProjectConfig["retrieval"]>;
  embeddings?: Partial<ProjectConfig["embeddings"]>;
  privacy?: Partial<ProjectConfig["privacy"]>;
  retention?: {
    migrationBackups?: number;
    sources?: Partial<Record<"git" | "codex" | "claude" | "manual", { maxAgeDays?: number | null }>>;
    overrides?: Array<{ sourceId: string; maxAgeDays: number | null }>;
  };
  deterministic?: Partial<ProjectConfig["deterministic"]> & {
    triggers?: Partial<ProjectConfig["deterministic"]["triggers"]>;
  };
}

type ProviderProfileConfig = Partial<ExtractorConfig>;

interface GlobalConfigFile {
  defaults?: {
    extractorProfile?: string | undefined;
    investigatorProfile?: string | undefined;
  };
  profiles?: Record<string, ProviderProfileConfig>;
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
  "!/config.json",
  "!/memory.sqlite",
  "!/project-summary.md",
  ""
].join("\n");
const LEGACY_ENV_ONLY_IGNORE = [".env", ".env.*", "!*.example", ""].join("\n");

export function ensureProjectConfig(rootDir: string): string {
  const configPath = join(rootDir, ".code-butler", "config.json");
  mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
  ensureProjectGitignore(rootDir);
  ensureProjectEnvExample(rootDir);
  ensureProjectConfigExamples(rootDir);
  if (existsSync(configPath)) return configPath;
  writeFileSync(configPath, JSON.stringify(defaultConfigFile(), null, 2));
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

export function loadExistingProjectConfig(rootDir: string): ProjectConfig {
  const configPath = join(rootDir, ".code-butler", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Project config not found at ${configPath}`);
  }
  return readProjectConfig(rootDir, configPath);
}

function readProjectConfig(rootDir: string, configPath: string): ProjectConfig {
  loadProjectEnv(rootDir);
  loadGlobalEnv();
  const raw = readFileSync(configPath, "utf8");
  const parsedValue: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
  validateProjectConfigFile(parsedValue);
  const parsed = parsedValue as ProjectConfigFile;
  const globalConfig = loadGlobalConfig();
  const defaults = defaultConfig(rootDir, configPath);

  const git = parsed.sources?.git ?? {};
  const codex = parsed.sources?.codex ?? {};
  const claude = parsed.sources?.claude ?? {};
  const deterministic = parsed.deterministic ?? {};

  return {
    configPath,
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
    extractor: resolveProviderConfig("extractor", defaults.extractor, globalConfig, parsed.extractor),
    investigator: resolveProviderConfig("investigator", defaults.investigator, globalConfig, parsed.investigator),
    promotion: {
      ...defaults.promotion,
      ...(parsed.promotion ?? {})
    },
    sync: {
      ...defaults.sync,
      ...(parsed.sync ?? {})
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
      overrides: parsed.retention?.overrides ?? defaults.retention!.overrides
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
      minSourceCategories: 2
    },
    sync: {
      autoSyncOnServerStart: true
    },
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
      overrides: []
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

function validateProjectConfigFile(value: unknown): void {
  if (!isConfigRecord(value)) throw new Error("Project config must be an object");
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
    assertKnownKeys(privacy, new Set(["allowRemoteEmbeddings", "redactionPatterns"]), "privacy");
    if (privacy.allowRemoteEmbeddings !== undefined && typeof privacy.allowRemoteEmbeddings !== "boolean") {
      throw new Error("privacy.allowRemoteEmbeddings must be a boolean");
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

  const retention = optionalConfigSection(value, "retention");
  if (retention) validateRetentionConfig(retention);
}

function optionalConfigSection(
  config: Record<string, unknown>,
  name: "retrieval" | "embeddings" | "privacy" | "retention"
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
  assertKnownKeys(retention, new Set(["migrationBackups", "sources", "overrides"]), "retention");
  if (retention.migrationBackups !== undefined && !isNonNegativeInteger(retention.migrationBackups)) {
    throw new Error("retention.migrationBackups must be a non-negative integer");
  }
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

function defaultConfigFile(): ProjectConfigFile {
  const home = homedir();
  const codexRoots = defaultCodexRoots(home);
  return {
    sources: {
      git: {
        enabled: true,
        repoPath: ".",
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
    promotion: {
      confidenceThreshold: 0.85,
      requireCommitAndConversation: true,
      minSourceCategories: 2
    },
    sync: {
      autoSyncOnServerStart: true
    },
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
      overrides: []
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
  return raw.trim().length > 0 ? (JSON.parse(raw) as GlobalConfigFile) : {};
}

function loadGlobalEnv(): void {
  loadEnvFile(join(globalConfigDir(), ".env"));
}

function loadProjectEnv(rootDir: string): void {
  loadEnvFile(join(rootDir, ".code-butler", ".env"));
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
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
  return {
    defaults: {
      extractorProfile: "cheap",
      investigatorProfile: "smart"
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
      description: "Project-specific redaction and retention examples. Replace example patterns before use.",
      privacy: {
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
