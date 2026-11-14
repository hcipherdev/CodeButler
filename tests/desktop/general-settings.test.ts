// Tests persisted device-wide automatic project initialization settings and explicit desktop setup.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGeneralSettings, saveGlobalAiSettings } from "../../src/config.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { prepareMcpProject } from "../../src/mcp/project-binding.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

describe("General settings", () => {
  let directory: string;
  let home: string;
  beforeEach(() => {
    directory = makeTempDir(); home = join(directory, "home");
    vi.stubEnv("CODE_BUTLER_HOME", home);
  });
  afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(directory); });

  it("defaults off without creating configuration, and preserves other settings when saved", async () => {
    expect(await handleDesktopRequest({ version: 1, action: "settings.general.read" })).toEqual({ autoInitializeProjects: false });
    expect(existsSync(home)).toBe(false);
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ sources: { codex: { enabled: false } } }));
    expect(await handleDesktopRequest({ version: 1, action: "settings.general.save", settings: { autoInitializeProjects: true } })).toEqual({ autoInitializeProjects: true });
    expect(loadGeneralSettings()).toEqual({ autoInitializeProjects: true });
    const fresh = join(directory, "fresh"); mkdirSync(fresh);
    await expect(prepareMcpProject(fresh, false)).rejects.toThrow("automatic project initialization is disabled");
    expect(readdirSync(fresh)).toEqual([]);
    saveGlobalAiSettings({});
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject({
      general: { autoInitializeProjects: true }, sources: { codex: { enabled: false } }, ai: {}
    });
    await handleDesktopRequest({ version: 1, action: "settings.general.save", settings: { autoInitializeProjects: false } });
    expect(await handleDesktopRequest({ version: 1, action: "settings.general.read" })).toEqual({ autoInitializeProjects: false });
  });

  it("rejects invalid values without replacing saved preferences", async () => {
    const file = { general: { autoInitializeProjects: true } };
    mkdirSync(home); writeFileSync(join(home, "config.json"), JSON.stringify(file));
    await expect(handleDesktopRequest({ version: 1, action: "settings.general.save", settings: { autoInitializeProjects: "false" } } as never)).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(file);
  });

  it("allows explicit Add project while automatic initialization is off", async () => {
    const root = join(directory, "project"); mkdirSync(root);
    await expect(prepareMcpProject(root)).rejects.toThrow("automatic project initialization is disabled");
    expect(existsSync(join(root, ".code-butler"))).toBe(false);
    const result = await handleDesktopRequest({ version: 1, action: "projects.add", root, initialize: true }, {
      ensureGlobalWatcher: () => {},
      initializationOptions: { generator: { async generate() { return "## What this is\n\nExplicit setup.\n"; } } }
    });
    expect(result).toMatchObject({ initialized: true });
    await expect(prepareMcpProject(root)).resolves.toEqual({ configCreated: false, databaseCreated: false });
    expect(loadGeneralSettings().autoInitializeProjects).toBe(false);
  });
});
