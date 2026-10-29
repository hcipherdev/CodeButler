// Tests the remote-model opt-in: requiresConsent in loadProjectConfig(), credentialStatus() and buildConfiguredExtractor(), and migrateRemoteModelConsent() in src/ai/consent.ts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitsRemoteModelConsent, migrateRemoteModelConsent } from "../../src/ai/consent.js";
import { credentialStatus, REMOTE_MODEL_CONSENT } from "../../src/ai/credentials.js";
import { ensureGlobalConfig, ensureProjectConfig, loadProjectConfig, readRemoteModelConsent, setRemoteModelConsent } from "../../src/config.js";
import { buildConfiguredExtractor } from "../../src/sync/service.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let root: string;
let home: string;

beforeEach(() => {
  root = makeTempDir();
  home = makeTempDir();
  vi.stubEnv("CODE_BUTLER_HOME", home);
  vi.stubEnv("OPENAI_API_KEY", "sk-exported-for-another-tool");
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDir(root);
  cleanupTempDir(home);
});

const writeProjectConfig = (value: object, file = "config.json") => {
  ensureProjectConfig(root);
  writeFileSync(join(root, ".code-butler", file), JSON.stringify(value));
};

describe("remote model consent", () => {
  it("keeps the built-in default off when its key only sits in the shell environment", () => {
    const config = loadProjectConfig(root);
    expect(config.extractor.requiresConsent).toBe(true);
    expect(config.investigator.requiresConsent).toBe(true);
    expect(config.models?.summary.requiresConsent).toBe(true);
    expect(awaitsRemoteModelConsent(config)).toBe(true);
    expect(credentialStatus(config.extractor)).toMatchObject({ ok: false, keySource: "env", missing: [REMOTE_MODEL_CONSENT] });
    expect(buildConfiguredExtractor(config)).toBeUndefined();
  });

  it("runs once this device opts in, and the choice stays in config.local.json", () => {
    setRemoteModelConsent(root, true);
    const config = loadProjectConfig(root);
    expect(awaitsRemoteModelConsent(config)).toBe(false);
    expect(credentialStatus(config.extractor).ok).toBe(true);
    expect(buildConfiguredExtractor(config)).toBeDefined();
    expect(readRemoteModelConsent(root)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".code-butler", "config.json"), "utf8"))).toEqual({});
    setRemoteModelConsent(root, false);
    expect(loadProjectConfig(root).extractor.requiresConsent).toBe(true);
  });

  it("treats a provider written in config, including a local server, or a key in Butler's .env as chosen", () => {
    writeProjectConfig({ extractor: { model: "gpt-5" } });
    expect(loadProjectConfig(root).extractor.requiresConsent).toBeUndefined();

    writeProjectConfig({});
    writeProjectConfig({ extractor: { baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "" } }, "config.local.json");
    expect(loadProjectConfig(root).extractor.requiresConsent).toBeUndefined();

    writeProjectConfig({}, "config.local.json");
    vi.stubEnv("OPENAI_API_KEY", "");
    ensureGlobalConfig();
    writeFileSync(join(home, ".env"), "OPENAI_API_KEY=sk-saved-for-butler\n");
    const config = loadProjectConfig(root);
    expect(config.extractor.requiresConsent).toBeUndefined();
    expect(config.investigator.requiresConsent).toBeUndefined();
  });

  it("does not count the generated profiles as a choice unless their destination changed", () => {
    const globalPath = ensureGlobalConfig();
    const global = JSON.parse(readFileSync(globalPath, "utf8"));
    global.profiles.cheap.model = "gpt-4.1-mini";
    writeFileSync(globalPath, JSON.stringify(global));
    expect(loadProjectConfig(root).extractor.requiresConsent).toBe(true);

    global.profiles.cheap.baseUrl = "https://openrouter.ai/api/v1";
    writeFileSync(globalPath, JSON.stringify(global));
    expect(loadProjectConfig(root).extractor.requiresConsent).toBeUndefined();
    expect(loadProjectConfig(root).investigator.requiresConsent).toBe(true);
  });

  it("rejects a non-boolean setting", () => {
    writeProjectConfig({ privacy: { allowRemoteModels: "yes" } });
    expect(() => loadProjectConfig(root)).toThrow("privacy.allowRemoteModels must be a boolean");
  });
});

describe("migrateRemoteModelConsent", () => {
  const deviceId = "6f1c3a52-6d1e-4c8a-9a51-2f7b0c9d4e10";
  function fakeStore(): { db: DatabaseSync; localDb: DatabaseSync; paths: { rootDir: string; dataDir: string } } & Record<string, unknown> {
    mkdirSync(join(root, ".code-butler"), { recursive: true });
    const db = new DatabaseSync(":memory:");
    const localDb = new DatabaseSync(":memory:");
    db.exec("create table memory_candidates (id text primary key, origin_json text)");
    localDb.exec("create table extraction_runs (id text primary key, error text)");
    return { db, localDb, paths: { rootDir: root, dataDir: join(root, ".code-butler") } };
  }
  const origin = (id: string) => JSON.stringify({ deviceId: id, platform: "darwin", arch: "arm64", generatedAt: "2026-10-01T00:00:00.000Z", method: "llm", channel: "sync" });

  it("records consent once where extraction already ran on this device", () => {
    const store = fakeStore();
    store.localDb.prepare("insert into extraction_runs values ('run-1', null)").run();
    const migrated = migrateRemoteModelConsent(store as never, loadProjectConfig(root), () => deviceId);
    expect(awaitsRemoteModelConsent(migrated)).toBe(false);
    expect(buildConfiguredExtractor(migrated)).toBeDefined();
    expect(readRemoteModelConsent(root)).toBe(true);
  });

  it("counts this device's LLM memories when the run history was pruned", () => {
    const store = fakeStore();
    store.db.prepare("insert into memory_candidates values ('c1', ?)").run(origin(deviceId));
    migrateRemoteModelConsent(store as never, loadProjectConfig(root), () => deviceId);
    expect(readRemoteModelConsent(root)).toBe(true);
  });

  it("ignores failed runs, other devices' memories and an answer already given", () => {
    const store = fakeStore();
    store.localDb.prepare("insert into extraction_runs values ('run-1', 'provider failed')").run();
    store.db.prepare("insert into memory_candidates values ('c1', ?)").run(origin("0b6c0f0e-1d1f-4f43-8f0e-9b0f7e0c2a11"));
    const config = loadProjectConfig(root);
    expect(migrateRemoteModelConsent(store as never, config, () => deviceId)).toBe(config);
    expect(readRemoteModelConsent(root)).toBeUndefined();

    setRemoteModelConsent(root, false);
    store.localDb.prepare("insert into extraction_runs values ('run-2', null)").run();
    migrateRemoteModelConsent(store as never, loadProjectConfig(root), () => deviceId);
    expect(readRemoteModelConsent(root)).toBe(false);
  });
});
