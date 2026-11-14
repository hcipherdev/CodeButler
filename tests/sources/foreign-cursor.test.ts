// Tests foreignCursorKey(), foreignVerdictHolds() and the foreign-log skip in scanClaudeFiles()/syncClaudeSource() (src/sources/codex.ts), plus watcherPassIdle() via syncWatchedProjectMemory() (src/sync/service.ts).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureProjectConfig, loadProjectConfig } from "../../src/config.js";
import type { ProjectConfig } from "../../src/types.js";
import { foreignCursorKey, foreignVerdictHolds, scanClaudeFiles, scanCodexFiles, syncClaudeSource, syncCodexSource } from "../../src/sources/codex.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { syncWatchedProjectMemory } from "../../src/sync/service.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

const claudeLine = (cwd: string, text: string, role: "user" | "assistant" = "user") => JSON.stringify({
  type: role, timestamp: "2026-11-04T10:00:00Z", sessionId: `session-${text.length}`, cwd,
  message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] }
});
const codexLines = (cwd: string, text: string) => [
  JSON.stringify({ timestamp: "2026-11-04T10:00:00Z", type: "session_meta", payload: { id: `codex-${text.length}`, cwd } }),
  JSON.stringify({ timestamp: "2026-11-04T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
].join("\n");

function workspace(): { root: string; claudeDir: string; codexDir: string; other: string; config: ProjectConfig } {
  const directory = makeTempDir(); roots.push(directory);
  const root = join(directory, "project");
  const claudeDir = join(directory, "claude", "projects");
  const codexDir = join(directory, "codex", "sessions");
  mkdirSync(root, { recursive: true }); mkdirSync(join(claudeDir, "other"), { recursive: true }); mkdirSync(codexDir, { recursive: true });
  ensureProjectConfig(root);
  const config = loadProjectConfig(root);
  config.sources.git.enabled = false;
  config.sources.claude = { ...config.sources.claude, enabled: true, roots: [claudeDir], projectOnly: true };
  config.sources.codex = { ...config.sources.codex, enabled: true, roots: [codexDir], includeDefaultRoots: false, projectOnly: true };
  return { root, claudeDir, codexDir, other: join(directory, "other-project"), config };
}

function foreignCursor(root: string, source: "codex" | "claude", path: string): string | undefined {
  const store = openConfiguredMemoryStore(root); store.init();
  try { return store.getSyncCursor(source, foreignCursorKey(path))?.cursorValue; } finally { store.close(); }
}

it("records another project's Claude log once and keeps skipping it while it grows", () => {
  const { root, claudeDir, other, config } = workspace();
  const log = join(claudeDir, "other", "session.jsonl");
  writeFileSync(log, `${claudeLine(other, "Work in another project")}\n`);
  const store = openConfiguredMemoryStore(root); store.init();
  try { expect(syncClaudeSource(store, config.sources.claude, config.sources.git.repoPath).imported).toBe(0); }
  finally { store.close(); }
  const stored = foreignCursor(root, "claude", log);
  expect(stored).toBeDefined();

  // An active session in the other project keeps appending; it must not be parsed here again.
  appendFileSync(log, `${claudeLine(other, "More work over there, much longer than before", "assistant")}\n`);
  const [entry] = scanClaudeFiles([log], new Map([[log, ""]]), (path, signature) => foreignVerdictHolds("claude", stored, config.sources.git.repoPath, signature));
  expect(entry).toMatchObject({ foreign: true });
  expect(entry!.result).toBeUndefined();

  // A moved project checks again.
  const [moved] = scanClaudeFiles([log], new Map([[log, ""]]), (path, signature) => foreignVerdictHolds("claude", stored, join(root, "..", "moved"), signature));
  expect(moved!.foreign).toBeUndefined();
  expect(moved!.result).toBeDefined();
});

it("re-checks another project's Codex log whenever it changes", () => {
  const { root, codexDir, other, config } = workspace();
  const log = join(codexDir, "rollout-other.jsonl");
  writeFileSync(log, codexLines(other, "Codex work elsewhere"));
  const store = openConfiguredMemoryStore(root); store.init();
  try { expect(syncCodexSource(store, config.sources.codex, config.sources.git.repoPath).imported).toBe(0); }
  finally { store.close(); }
  const stored = foreignCursor(root, "codex", log);
  const holds = (path: string, signature: string) => foreignVerdictHolds("codex", stored, config.sources.git.repoPath, signature);
  expect(scanCodexFiles([log], new Map([[log, ""]]), holds)[0]).toMatchObject({ foreign: true });

  // Codex takes its latest cwd, so a changed log could now belong here.
  appendFileSync(log, `\n${JSON.stringify({ timestamp: "2026-11-04T10:01:00Z", type: "turn_context", payload: { cwd: root } })}`);
  const [changed] = scanCodexFiles([log], new Map([[log, ""]]), holds);
  expect(changed!.foreign).toBeUndefined();
  expect(changed!.result).toBeDefined();
});

it("ignores recorded verdicts once every conversation is included", () => {
  const { root, claudeDir, other, config } = workspace();
  const log = join(claudeDir, "other", "session.jsonl");
  writeFileSync(log, `${claudeLine(other, "Work in another project")}\n${claudeLine(other, "And the answer", "assistant")}\n`);
  const store = openConfiguredMemoryStore(root); store.init();
  try {
    expect(syncClaudeSource(store, config.sources.claude, config.sources.git.repoPath).imported).toBe(0);
    expect(syncClaudeSource(store, { ...config.sources.claude, projectOnly: false }, config.sources.git.repoPath).imported).toBe(1);
  } finally { store.close(); }
});

it("stops parsing other projects' logs after the parse budget catches up, and reports idle passes", async () => {
  const { root, claudeDir, other, config } = workspace();
  config.sources.codex.enabled = false;
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(join(claudeDir, "other", `session-${index}.jsonl`), `${claudeLine(other, `Other project session ${index}`)}\n`);
  }
  const first = await syncWatchedProjectMemory(root, config, { source: "all" });
  // 100 parsed, 20 left for the next pass: not idle.
  expect(first.idle).toBe(false);
  await syncWatchedProjectMemory(root, config, { source: "all" });
  const third = await syncWatchedProjectMemory(root, config, { source: "all" });
  expect(third.idle).toBe(true);

  const store = openConfiguredMemoryStore(root); store.init();
  try {
    const rows = store.db.prepare("select cursor_key, cursor_value from sync_cursors where source = 'claude'").all() as Array<{ cursor_key: string; cursor_value: string }>;
    expect(rows).toHaveLength(120);
    // Other projects' transcript paths are never stored in this project's database.
    expect(rows.every(row => row.cursor_key.startsWith("foreign:") && !row.cursor_key.includes("session") && !row.cursor_value.includes("other"))).toBe(true);
  } finally { store.close(); }

  // A conversation in this project ends the quiet stretch.
  mkdirSync(join(claudeDir, "project"), { recursive: true });
  writeFileSync(join(claudeDir, "project", "mine.jsonl"), `${claudeLine(root, "Work here")}\n${claudeLine(root, "Done here", "assistant")}\n`);
  const active = await syncWatchedProjectMemory(root, config, { source: "all" });
  expect(active.sources.claude.imported).toBe(1);
  expect(active.idle).toBe(false);
});
