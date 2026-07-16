import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectConfig, loadProjectConfig } from "../src/config.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("project config", () => {
  let tempDirs: string[] = [];
  const envKeys = [
    "CODE_BUTLER_HOME",
    "CODE_BUTLER_TEST_FILE_ENV",
    "CODE_BUTLER_TEST_EXISTING_ENV",
    "CODE_BUTLER_TEST_GLOBAL_ENV",
    "CODE_BUTLER_TEST_PROFILE_KEY",
    "CODE_BUTLER_TEST_SMART_KEY"
  ];
  const originalEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
    for (const [key, original] of originalEnv.entries()) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
  });

  it("creates defaults and merges on-disk overrides", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    originalEnv.set("CODE_BUTLER_HOME", process.env.CODE_BUTLER_HOME);
    process.env.CODE_BUTLER_HOME = globalHome;

    const configPath = ensureProjectConfig(rootDir);
    const defaults = loadProjectConfig(rootDir);
    const generatedProjectConfig = JSON.parse(readFileSync(configPath, "utf8"));

    expect(existsSync(configPath)).toBe(true);
    expect(generatedProjectConfig.extractor).toBeUndefined();
    expect(generatedProjectConfig.investigator).toBeUndefined();
    expect(generatedProjectConfig.retrieval).toEqual({ mode: "fts", rrfK: 60 });
    expect(generatedProjectConfig.embeddings).toEqual({
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      batchSize: 16
    });
    expect(generatedProjectConfig.privacy).toEqual({ allowRemoteEmbeddings: false, redactionPatterns: [] });
    expect(generatedProjectConfig.retention).toEqual({
      migrationBackups: 2,
      sources: {
        git: { maxAgeDays: null },
        codex: { maxAgeDays: null },
        claude: { maxAgeDays: null },
        manual: { maxAgeDays: null }
      },
      overrides: []
    });
    expect(existsSync(join(rootDir, ".code-butler", ".gitignore"))).toBe(true);
    expect(readFileSync(join(rootDir, ".code-butler", ".gitignore"), "utf8")).toBe(
      ["/*", "!/.gitignore", "!/config.json", "!/memory.sqlite", "!/project-summary.md", ""].join("\n")
    );
    expect(existsSync(join(rootDir, ".code-butler", ".env.example"))).toBe(true);
    expect(existsSync(join(rootDir, ".code-butler", "config.examples.json"))).toBe(true);
    expect(defaults.sources.git.enabled).toBe(true);
    expect(defaults.promotion.confidenceThreshold).toBe(0.85);
    expect(defaults.extractor.provider).toBe("openai-compatible");
    expect(defaults.sources.codex.roots).toEqual([
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".codex", "archived_sessions")
    ]);
    expect(defaults.sources.codex.includeDefaultRoots).toBe(true);
    expect(defaults.sources.codex.projectOnly).toBe(true);
    expect(defaults.sources.claude.projectOnly).toBe(true);
    expect(defaults.investigator.mode).toBe("native-rlm");
    expect(defaults.investigator.maxDepth).toBe(3);
    expect(defaults.deterministic.enabled).toBe(true);
    expect(defaults.deterministic.promoteStrongSignals).toBe(true);
    expect(defaults.deterministic.triggers.conversationDirectives).toBe(true);
    expect(defaults.retrieval).toEqual({ mode: "fts", rrfK: 60 });
    expect(defaults.embeddings).toEqual({
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      batchSize: 16
    });
    expect(defaults.privacy).toEqual({ allowRemoteEmbeddings: false, redactionPatterns: [] });
    expect(defaults.retention!.migrationBackups).toBe(2);
    expect(defaults.retention!.sources.manual.maxAgeDays).toBeNull();

    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          sources: {
            git: { repoPath: "./repo", enabled: false },
            codex: { roots: ["./fixtures/codex"], enabled: true, includeDefaultRoots: false, projectOnly: false },
            claude: { roots: ["./fixtures/claude"], enabled: true }
          },
          extractor: {
            model: "gpt-5-mini",
            apiKeyEnv: "TEST_API_KEY"
          },
          investigator: {
            enabled: true,
            model: "gpt-5-investigator",
            maxSteps: 24,
            returnTrace: true
          },
          deterministic: {
            enabled: true,
            triggers: {
              docsFacts: false
            }
          }
        },
        null,
        2
      )
    );

    const overridden = loadProjectConfig(rootDir);
    expect(overridden.sources.git.enabled).toBe(false);
    expect(overridden.sources.git.repoPath).toBe(join(rootDir, "repo"));
    expect(overridden.sources.codex.roots).toEqual([join(rootDir, "fixtures/codex")]);
    expect(overridden.sources.codex.includeDefaultRoots).toBe(false);
    expect(overridden.sources.codex.projectOnly).toBe(false);
    expect(overridden.extractor.model).toBe("gpt-5-mini");
    expect(overridden.extractor.apiKeyEnv).toBe("TEST_API_KEY");
    expect(overridden.investigator.model).toBe("gpt-5-investigator");
    expect(overridden.investigator.maxSteps).toBe(24);
    expect(overridden.investigator.returnTrace).toBe(true);
    expect(overridden.deterministic.enabled).toBe(true);
    expect(overridden.deterministic.promoteStrongSignals).toBe(true);
    expect(overridden.deterministic.triggers.conversationDirectives).toBe(true);
    expect(overridden.deterministic.triggers.docsFacts).toBe(false);
  });

  it("creates project-local env and config examples without secrets", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);

    ensureProjectConfig(rootDir);

    const envExample = readFileSync(join(rootDir, ".code-butler", ".env.example"), "utf8");
    expect(envExample).toContain("OPENAI_API_KEY=");
    expect(envExample).toContain("ANTHROPIC_AWS_API_KEY=");
    expect(envExample).toContain("ANTHROPIC_AWS_WORKSPACE_ID=");
    expect(envExample).toContain("AWS_REGION=us-east-1");
    expect(envExample).not.toContain("sk-");

    const examples = JSON.parse(readFileSync(join(rootDir, ".code-butler", "config.examples.json"), "utf8"));
    expect(examples.note).toContain("extractor and investigator are independent");
    expect(examples.localEmbeddings).toMatchObject({
      retrieval: { mode: "hybrid", rrfK: 60 },
      embeddings: {
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "nomic-embed-text"
      },
      privacy: { allowRemoteEmbeddings: false }
    });
    expect(examples.privacyControls).toEqual({
      description: expect.any(String),
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
    });
    expect(examples.openaiCompatible.extractor).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(examples.openaiCompatible.investigator).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(examples.claudeAnthropicAws.extractor).toMatchObject({
      provider: "anthropic-aws",
      apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
      workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
      regionEnv: "AWS_REGION"
    });
    expect(examples.claudeAnthropicAws.investigator).toMatchObject({
      enabled: true,
      provider: "anthropic-aws",
      apiKeyEnv: "ANTHROPIC_AWS_API_KEY",
      workspaceIdEnv: "ANTHROPIC_AWS_WORKSPACE_ID",
      regionEnv: "AWS_REGION"
    });
  });

  it("merges retrieval, embedding, and privacy overrides independently from provider profiles", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    originalEnv.set("CODE_BUTLER_HOME", process.env.CODE_BUTLER_HOME);
    process.env.CODE_BUTLER_HOME = globalHome;
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(
      configPath,
      JSON.stringify({
        retrieval: { mode: "hybrid", rrfK: 42 },
        embeddings: {
          enabled: true,
          baseUrl: "https://embeddings.example/v1/",
          model: "embedding-model",
          apiKeyEnv: "EMBEDDING_API_KEY",
          batchSize: 8
        },
        privacy: {
          allowRemoteEmbeddings: true,
          redactionPatterns: [{ name: "tenant token", pattern: "TENANT-[0-9]+", kind: "regex" }]
        },
        retention: {
          migrationBackups: 3,
          sources: { codex: { maxAgeDays: 30 } },
          overrides: [{ sourceId: "temporary-conversation", maxAgeDays: 7 }]
        }
      })
    );

    const config = loadProjectConfig(rootDir);

    expect(config.retrieval).toEqual({ mode: "hybrid", rrfK: 42 });
    expect(config.embeddings).toEqual({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://embeddings.example/v1/",
      model: "embedding-model",
      apiKeyEnv: "EMBEDDING_API_KEY",
      batchSize: 8
    });
    expect(config.retention?.overrides).toEqual([
      { sourceId: "temporary-conversation", maxAgeDays: 7 }
    ]);
    expect(config.privacy).toEqual({
      allowRemoteEmbeddings: true,
      redactionPatterns: [{ name: "tenant token", pattern: "TENANT-[0-9]+", kind: "regex" }]
    });
    expect(config.retention).toMatchObject({
      migrationBackups: 3,
      sources: { codex: { maxAgeDays: 30 }, git: { maxAgeDays: null } }
    });
    expect(config.extractor).toMatchObject({ model: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY" });
    expect(config.investigator).toMatchObject({ model: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY" });
  });

  it("applies every Release 3 default to a legacy config without Release 3 sections", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(configPath, JSON.stringify({ sources: { git: { enabled: false } } }));

    const config = loadProjectConfig(rootDir);

    expect(config.retrieval).toEqual({ mode: "fts", rrfK: 60 });
    expect(config.embeddings).toEqual({
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      batchSize: 16
    });
    expect(config.privacy).toEqual({ allowRemoteEmbeddings: false, redactionPatterns: [] });
    expect(config.retention!.migrationBackups).toBe(2);
  });

  it.each([
    [{ retrieval: "hybrid" }, "retrieval must be an object"],
    [{ retrieval: { mode: "semantic" } }, "retrieval.mode must be fts or hybrid"],
    [{ retrieval: { rrfK: 1.5 } }, "retrieval.rrfK must be a positive integer"],
    [{ embeddings: { enabled: "false" } }, "embeddings.enabled must be a boolean"],
    [{ embeddings: { provider: "other" } }, "embeddings.provider must be openai-compatible"],
    [{ embeddings: { baseUrl: "not a URL" } }, "embeddings.baseUrl must be a valid HTTP(S) URL"],
    [{ embeddings: { model: " " } }, "embeddings.model must be a nonempty string"],
    [{ embeddings: { apiKeyEnv: "" } }, "embeddings.apiKeyEnv must be a nonempty string"],
    [{ embeddings: { batchSize: 0 } }, "embeddings.batchSize must be a positive integer"],
    [{ privacy: { allowRemoteEmbeddings: "false" } }, "privacy.allowRemoteEmbeddings must be a boolean"],
    [{ privacy: { redactionPatterns: "secret" } }, "privacy.redactionPatterns must be an array"],
    [{ privacy: { redactionPatterns: [{ name: "", kind: "literal", pattern: "secret" }] } }, "privacy.redactionPatterns[0].name must use safe characters"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "(" }] } }, "privacy.redactionPatterns[0].pattern must be a valid regular expression"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "secret", flags: "x" }] } }, "privacy.redactionPatterns[0].flags contains unsupported flags"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "a*" }] } }, "privacy.redactionPatterns[0].pattern must not match empty text"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "(?=secret)secret" }] } }, "privacy.redactionPatterns[0].pattern uses unsupported lookaround or backreferences"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "(?<token>a)\\k<token>" }] } }, "privacy.redactionPatterns[0].pattern uses unsupported lookaround or backreferences"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "(a+)+" }] } }, "privacy.redactionPatterns[0].pattern contains unsafe nested repetition"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "^(a|aa)+$" }] } }, "privacy.redactionPatterns[0].pattern contains unsafe quantified groups"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "^((a|aa))+$" }] } }, "privacy.redactionPatterns[0].pattern contains unsafe quantified groups"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "^a+a+a+b$" }] } }, "privacy.redactionPatterns[0].pattern contains repeated unbounded repetition"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "regex", pattern: "^.*.*Z$" }] } }, "privacy.redactionPatterns[0].pattern contains repeated unbounded repetition"],
    [{ privacy: { redactionPatterns: [{ name: "bad", kind: "literal", pattern: "secret", flags: "i" }] } }, "privacy.redactionPatterns[0].flags are only valid for regex rules"],
    [{ retention: { migrationBackups: -1 } }, "retention.migrationBackups must be a non-negative integer"],
    [{ retention: { sources: { git: { maxAgeDays: 0 } } } }, "retention.sources.git.maxAgeDays must be null or a positive integer"]
    ,[{ privacy: { redactionPattern: [] } }, "privacy contains unknown key: redactionPattern"]
    ,[{ privacy: { redactionPatterns: [{ name: "bad", kind: "literal", pattern: "secret", typo: true }] } }, "privacy.redactionPatterns[0] contains unknown key: typo"]
    ,[{ retention: { sources: { github: { maxAgeDays: 30 } } } }, "retention.sources contains unknown key: github"]
    ,[{ retention: { sources: { git: { maxAgeDay: 30 } } } }, "retention.sources.git contains unknown key: maxAgeDay"]
  ])("rejects malformed Release 3 config %#", (invalid, message) => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(configPath, JSON.stringify(invalid));

    expect(() => loadProjectConfig(rootDir)).toThrow(message);
  });

  it("rejects malformed project config JSON", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(configPath, "{ not valid JSON");

    expect(() => loadProjectConfig(rootDir)).toThrow(SyntaxError);
  });

  it("backfills missing example files without rewriting existing active config", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const codeButlerDir = join(rootDir, ".code-butler");
    const configPath = join(codeButlerDir, "config.json");
    const existingConfig = JSON.stringify({ extractor: { model: "custom-extractor" } }, null, 2);
    mkdirSync(codeButlerDir, { recursive: true });
    writeFileSync(configPath, existingConfig);

    ensureProjectConfig(rootDir);

    expect(readFileSync(configPath, "utf8")).toBe(existingConfig);
    expect(existsSync(join(codeButlerDir, ".env.example"))).toBe(true);
    expect(existsSync(join(codeButlerDir, "config.examples.json"))).toBe(true);
  });

  it("upgrades legacy project ignore files to hide local memory state", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const codeButlerDir = join(rootDir, ".code-butler");
    const gitignorePath = join(codeButlerDir, ".gitignore");
    mkdirSync(codeButlerDir, { recursive: true });
    writeFileSync(gitignorePath, [".env", ".env.*", "!*.example", ""].join("\n"));

    ensureProjectConfig(rootDir);

    expect(readFileSync(gitignorePath, "utf8")).toBe(
      ["/*", "!/.gitignore", "!/config.json", "!/memory.sqlite", "!/project-summary.md", ""].join("\n")
    );
  });

  it("adds current Codex sessions when legacy configs only point at archived sessions", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          sources: {
            codex: {
              enabled: true,
              roots: [join(homedir(), ".codex", "archived_sessions")]
            }
          }
        },
        null,
        2
      )
    );

    const config = loadProjectConfig(rootDir);

    expect(config.sources.codex.roots).toEqual([
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".codex", "archived_sessions")
    ]);
    expect(config.sources.codex.includeDefaultRoots).toBe(true);
  });

  it("preserves exact Codex roots when default roots are disabled", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          sources: {
            codex: {
              enabled: true,
              includeDefaultRoots: false,
              roots: ["./custom-codex"]
            }
          }
        },
        null,
        2
      )
    );

    const config = loadProjectConfig(rootDir);

    expect(config.sources.codex.roots).toEqual([join(rootDir, "custom-codex")]);
  });

  it("loads missing environment variables from project .code-butler/.env", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.CODE_BUTLER_TEST_EXISTING_ENV = "from-shell";

    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(
      join(rootDir, ".code-butler", ".env"),
      [
        "# Project-local Code Butler credentials",
        "export CODE_BUTLER_TEST_FILE_ENV=\"from-file\"",
        "CODE_BUTLER_TEST_EXISTING_ENV=from-file"
      ].join("\n")
    );

    loadProjectConfig(rootDir);

    expect(process.env.CODE_BUTLER_TEST_FILE_ENV).toBe("from-file");
    expect(process.env.CODE_BUTLER_TEST_EXISTING_ENV).toBe("from-shell");
  });

  it("loads missing environment variables from global Code Butler .env", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    for (const key of ["CODE_BUTLER_HOME", "CODE_BUTLER_TEST_GLOBAL_ENV"]) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.CODE_BUTLER_HOME = globalHome;

    writeFileSync(join(globalHome, ".env"), "CODE_BUTLER_TEST_GLOBAL_ENV=from-global\n");

    loadProjectConfig(rootDir);

    expect(process.env.CODE_BUTLER_TEST_GLOBAL_ENV).toBe("from-global");
  });

  it("keeps shell environment over project and global env files", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    for (const key of ["CODE_BUTLER_HOME", "CODE_BUTLER_TEST_GLOBAL_ENV"]) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.CODE_BUTLER_HOME = globalHome;
    process.env.CODE_BUTLER_TEST_GLOBAL_ENV = "from-shell";

    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", ".env"), "CODE_BUTLER_TEST_GLOBAL_ENV=from-project\n");
    writeFileSync(join(globalHome, ".env"), "CODE_BUTLER_TEST_GLOBAL_ENV=from-global\n");

    loadProjectConfig(rootDir);

    expect(process.env.CODE_BUTLER_TEST_GLOBAL_ENV).toBe("from-shell");
  });

  it("keeps project env values over global env values", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    for (const key of ["CODE_BUTLER_HOME", "CODE_BUTLER_TEST_GLOBAL_ENV"]) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.CODE_BUTLER_HOME = globalHome;

    mkdirSync(join(rootDir, ".code-butler"), { recursive: true });
    writeFileSync(join(rootDir, ".code-butler", ".env"), "CODE_BUTLER_TEST_GLOBAL_ENV=from-project\n");
    writeFileSync(join(globalHome, ".env"), "CODE_BUTLER_TEST_GLOBAL_ENV=from-global\n");

    loadProjectConfig(rootDir);

    expect(process.env.CODE_BUTLER_TEST_GLOBAL_ENV).toBe("from-project");
  });

  it("resolves global default profiles into concrete provider config", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    originalEnv.set("CODE_BUTLER_HOME", process.env.CODE_BUTLER_HOME);
    process.env.CODE_BUTLER_HOME = globalHome;
    writeFileSync(
      join(globalHome, "config.json"),
      JSON.stringify(
        {
          defaults: {
            extractorProfile: "cheap",
            investigatorProfile: "smart"
          },
          profiles: {
            cheap: {
              provider: "openai-compatible",
              baseUrl: "https://cheap.example/v1",
              model: "cheap-model",
              apiKeyEnv: "CODE_BUTLER_TEST_PROFILE_KEY",
              maxTokens: 1200
            },
            smart: {
              provider: "openai-compatible",
              baseUrl: "https://smart.example/v1",
              model: "smart-model",
              apiKeyEnv: "CODE_BUTLER_TEST_SMART_KEY",
              maxTokens: 2500
            }
          }
        },
        null,
        2
      )
    );

    const config = loadProjectConfig(rootDir);

    expect(config.extractor).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://cheap.example/v1",
      model: "cheap-model",
      apiKeyEnv: "CODE_BUTLER_TEST_PROFILE_KEY",
      maxTokens: 1200
    });
    expect(config.investigator).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://smart.example/v1",
      model: "smart-model",
      apiKeyEnv: "CODE_BUTLER_TEST_SMART_KEY",
      maxTokens: 2500
    });
  });

  it("allows project profiles and explicit fields to override global defaults", () => {
    const rootDir = makeTempDir();
    const globalHome = makeTempDir();
    tempDirs.push(rootDir, globalHome);
    originalEnv.set("CODE_BUTLER_HOME", process.env.CODE_BUTLER_HOME);
    process.env.CODE_BUTLER_HOME = globalHome;
    writeFileSync(
      join(globalHome, "config.json"),
      JSON.stringify(
        {
          defaults: { extractorProfile: "cheap", investigatorProfile: "cheap" },
          profiles: {
            cheap: {
              provider: "openai-compatible",
              baseUrl: "https://cheap.example/v1",
              model: "cheap-model",
              apiKeyEnv: "CODE_BUTLER_TEST_PROFILE_KEY"
            },
            smart: {
              provider: "openai-compatible",
              baseUrl: "https://smart.example/v1",
              model: "smart-model",
              apiKeyEnv: "CODE_BUTLER_TEST_SMART_KEY"
            }
          }
        },
        null,
        2
      )
    );
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          extractor: {
            profile: "smart",
            model: "project-model"
          },
          investigator: {
            profile: "smart",
            maxSteps: 24
          }
        },
        null,
        2
      )
    );

    const config = loadProjectConfig(rootDir);

    expect(config.extractor).toMatchObject({
      baseUrl: "https://smart.example/v1",
      model: "project-model",
      apiKeyEnv: "CODE_BUTLER_TEST_SMART_KEY"
    });
    expect(config.investigator).toMatchObject({
      baseUrl: "https://smart.example/v1",
      model: "smart-model",
      apiKeyEnv: "CODE_BUTLER_TEST_SMART_KEY",
      maxSteps: 24
    });
  });

  it("fails clearly when a selected profile is missing", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(configPath, JSON.stringify({ extractor: { profile: "missing" } }, null, 2));

    expect(() => loadProjectConfig(rootDir)).toThrow('Unknown Code Butler provider profile "missing" for extractor');
  });

  it("does not inherit OpenAI base URLs for Anthropic AWS provider overrides", () => {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    const configPath = ensureProjectConfig(rootDir);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          extractor: {
            provider: "anthropic-aws",
            model: "claude-haiku-4-5-20251001",
            apiKeyEnv: "ANTHROPIC_AWS_API_KEY"
          },
          investigator: {
            provider: "anthropic-aws",
            model: "claude-sonnet-4-6",
            apiKeyEnv: "ANTHROPIC_AWS_API_KEY"
          }
        },
        null,
        2
      )
    );

    const config = loadProjectConfig(rootDir);

    expect(config.extractor.baseUrl).toBeUndefined();
    expect(config.investigator.baseUrl).toBeUndefined();
  });
});
