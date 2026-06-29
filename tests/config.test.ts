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
    expect(existsSync(join(rootDir, ".code-butler", ".gitignore"))).toBe(true);
    expect(readFileSync(join(rootDir, ".code-butler", ".gitignore"), "utf8")).toBe(
      ["/*", "!/project-summary.md", ""].join("\n")
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

    expect(readFileSync(gitignorePath, "utf8")).toBe(["/*", "!/project-summary.md", ""].join("\n"));
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
