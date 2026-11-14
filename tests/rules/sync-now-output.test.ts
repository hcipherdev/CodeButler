// Tests runRulesCommand(["sync", "now"]) in src/cli/commands/rules.ts: the full status is printed when run by hand, and nothing when the global watcher runs it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/rules/sync.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/rules/sync.js")>(),
  syncGlobalRules: vi.fn(async () => ({ outcome: "completed", binding: { kind: "global-rules", revision: 3284 }, queue: { pending: false } }))
}));

const { runRulesCommand } = await import("../../src/cli/commands/rules.js");

// The command reports to the watcher over IPC; keep that off the test runner's own channel.
const send = process.send;
beforeEach(() => { process.send = vi.fn(() => true); });
afterEach(() => {
  vi.unstubAllEnvs();
  if (send === undefined) delete process.send;
  else process.send = send;
});

it("prints the rules sync status when run by hand", async () => {
  vi.stubEnv("CODE_BUTLER_WATCH_TOKEN", "");
  const lines: string[] = [];
  expect(await runRulesCommand(["sync", "now"], process.cwd(), line => lines.push(line))).toBe(0);
  expect(lines.join("\n")).toContain("\"revision\": 3284");
});

it("prints nothing when the global watcher runs it, since the watcher logs its own line", async () => {
  vi.stubEnv("CODE_BUTLER_WATCH_TOKEN", "watch-token");
  const lines: string[] = [];
  expect(await runRulesCommand(["sync", "now"], process.cwd(), line => lines.push(line))).toBe(0);
  expect(lines).toEqual([]);
});
