import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleDesktopRequest } from "../src/desktop/service.js";
import { newRuntimeRecord, registerRuntime } from "../src/runtime.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });

it("lists projects without inspecting hundreds of stale runtime records, then prunes them on demand", async () => {
  const directory = makeTempDir(); roots.push(directory);
  const home = join(directory, "home");
  vi.stubEnv("CODE_BUTLER_HOME", home);
  const runtimes = join(home, "runtimes"); mkdirSync(runtimes, { recursive: true });
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(runtimes, `${index}.json`), JSON.stringify({ pid: 99_999_999, token: String(index), processStart: "0", role: "mcp" }));
  }
  const started = performance.now();
  expect(await handleDesktopRequest({ version: 1, action: "projects.list" })).toMatchObject({ projects: [] });
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(readdirSync(runtimes)).toHaveLength(300);
  expect(await handleDesktopRequest({ version: 1, action: "watcher.runtime-details" })).toEqual({ processes: [] });
  expect(readdirSync(runtimes)).toHaveLength(0);
});

it("loads an accurate live process record only when Runtime details is requested", async () => {
  const directory = makeTempDir(); roots.push(directory);
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  const record = newRuntimeRecord("mcp");
  const unregister = registerRuntime(record);
  try {
    const projects = await handleDesktopRequest({ version: 1, action: "projects.list" });
    expect(projects).toMatchObject({ projects: [] });
    const details = await handleDesktopRequest({ version: 1, action: "watcher.runtime-details" });
    expect(details).toMatchObject({ processes: [expect.objectContaining({ token: record.token, pid: process.pid, role: "mcp" })] });
  } finally { unregister(); }
});
