import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ProjectConfig } from "./types.js";

interface ProjectConfigFile {
  sources?: {
    git?: Partial<ProjectConfig["sources"]["git"]>;
    codex?: Partial<ProjectConfig["sources"]["codex"]>;
    claude?: Partial<ProjectConfig["sources"]["claude"]>;
  };
  extractor?: Partial<ProjectConfig["extractor"]>;
  investigator?: Partial<ProjectConfig["investigator"]>;
  promotion?: Partial<ProjectConfig["promotion"]>;
  sync?: Partial<ProjectConfig["sync"]>;
  deterministic?: Partial<ProjectConfig["deterministic"]> & {
    triggers?: Partial<ProjectConfig["deterministic"]["triggers"]>;
  };
}

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
  const raw = readFileSync(configPath, "utf8");
  const parsed = raw.trim().length > 0 ? (JSON.parse(raw) as ProjectConfigFile) : {};
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
    extractor: mergeProviderConfig(defaults.extractor, parsed.extractor),
    investigator: mergeProviderConfig(defaults.investigator, parsed.investigator),
    promotion: {
      ...defaults.promotion,
      ...(parsed.promotion ?? {})
    },
    sync: {
      ...defaults.sync,
      ...(parsed.sync ?? {})
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

function mergeProviderConfig<T extends ProjectConfig["extractor"] | ProjectConfig["investigator"]>(
  defaults: T,
  overrides: Partial<T> | undefined
): T {
  const merged = {
    ...defaults,
    ...(overrides ?? {})
  };
  if (merged.provider === "anthropic-aws" && overrides?.baseUrl === undefined) {
    delete merged.baseUrl;
  }
  return merged;
}

function defaultConfigFile(): Omit<ProjectConfig, "configPath"> {
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

function loadProjectEnv(rootDir: string): void {
  const envPath = join(rootDir, ".code-butler", ".env");
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
  if (existsSync(gitignorePath)) return;
  writeFileSync(gitignorePath, [".env", ".env.*", "!*.example", ""].join("\n"));
}

function ensureProjectEnvExample(rootDir: string): void {
  const envExamplePath = join(rootDir, ".code-butler", ".env.example");
  if (existsSync(envExamplePath)) return;
  writeFileSync(
    envExamplePath,
    [
      "# Project-local Code Butler credentials",
      "# Copy this file to .code-butler/.env and fill in only the providers you use.",
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

function ensureProjectConfigExamples(rootDir: string): void {
  const examplesPath = join(rootDir, ".code-butler", "config.examples.json");
  if (existsSync(examplesPath)) return;
  writeFileSync(examplesPath, JSON.stringify(defaultConfigExamplesFile(), null, 2));
}

function defaultConfigExamplesFile(): Record<string, unknown> {
  return {
    note:
      "Examples only. Copy the extractor and/or investigator blocks you want into config.json. The extractor and investigator are independent and may use different providers, models, base URLs, and token budgets.",
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
