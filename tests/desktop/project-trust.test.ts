// Tests the "project.trust.approve" desktop action and the trust field of "project.overview" in src/desktop/service.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import { registerWatchedProject } from "../../src/global-watch.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

let directory: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) cleanupTempDir(directory);
  directory = undefined;
});

interface Pending { status: string; hash: string; settings: Array<{ path: string; value: string }>; envNames: string[] }

it("shows a repository's pending settings on the overview and approves exactly what was shown", async () => {
  directory = makeTempDir();
  const root = join(directory, "project");
  vi.stubEnv("HOME", join(directory, "user"));
  vi.stubEnv("CODE_BUTLER_HOME", join(directory, "home"));
  vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE", "legacy");
  mkdirSync(root);
  ensureProjectConfig(root);
  writeFileSync(join(root, ".code-butler", "config.json"), JSON.stringify({ extractor: { baseUrl: "https://team-proxy.example/v1", apiKeyEnv: "TEAM_KEY" } }));
  writeFileSync(join(root, ".code-butler", ".env"), "TEAM_KEY=sk-team\n");
  registerWatchedProject(root);

  const overview = await handleDesktopRequest({ version: 1, action: "project.overview", root }) as { trust?: Pending };
  expect(overview.trust).toMatchObject({
    status: "untrusted",
    settings: [{ path: "extractor.apiKeyEnv", value: '"TEAM_KEY"' }, { path: "extractor.baseUrl", value: '"https://team-proxy.example/v1"' }],
    envNames: ["TEAM_KEY"]
  });
  expect(JSON.stringify(overview.trust)).not.toContain("sk-team");
  const hash = overview.trust!.hash;

  await expect(handleDesktopRequest({ version: 1, action: "project.trust.approve", root, hash })).rejects.toMatchObject({ code: "confirmation-required" });
  await expect(handleDesktopRequest({ version: 1, action: "project.trust.approve", root, hash: "0".repeat(64), confirmed: true })).rejects.toMatchObject({ code: "stale-review" });
  expect(loadProjectConfig(root).extractor.baseUrl).toBe("https://api.openai.com/v1");

  const approved = await handleDesktopRequest({ version: 1, action: "project.trust.approve", root, hash, confirmed: true }) as Pending;
  expect(approved.status).toBe("trusted");
  expect(loadProjectConfig(root).extractor.baseUrl).toBe("https://team-proxy.example/v1");
  const after = await handleDesktopRequest({ version: 1, action: "project.overview", root }) as { trust?: Pending };
  expect(after.trust).toBeUndefined();
});
