import { loadProjectConfig } from "../../config.js";
import { getClaudeSourceStatus, getCodexSourceStatus } from "../../sources/codex.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";
import type { MemoryStore } from "../../storage/store.js";

export async function runSourcesCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "status" && subcommand !== "failures") {
    throw new Error("Usage: code-butler sources <status|failures> [--json]");
  }
  if (subcommand === "failures") {
    const unknownFlag = rest.find((arg) => arg !== "--json");
    if (unknownFlag) throw new Error(`Unknown sources failures option: ${unknownFlag}`);
  } else if (rest.length > 0) {
    throw new Error(`Unknown sources status option: ${rest[0]}`);
  }
  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    if (subcommand === "failures") {
      const failures = store.listSourceFailures({ limit: null });
      if (rest.includes("--json")) {
        stdout(JSON.stringify(failures, null, 2));
        return 0;
      }
      stdout("Source Failures");
      stdout(`unresolved=${failures.length}`);
      for (const failure of failures) {
        stdout(
          `${failure.adapter} path=${failure.path} code=${failure.errorCode} attempts=${failure.attempts} first=${failure.firstOccurredAt} last=${failure.lastOccurredAt} resolved=${failure.resolvedAt ?? "no"} message=${failure.message}`
        );
      }
      return 0;
    }
    const config = loadProjectConfig(cwd);
    const codex = getCodexSourceStatus(store, config.sources.codex, config.sources.git.repoPath);
    const claude = getClaudeSourceStatus(store, config.sources.claude, config.sources.git.repoPath);
    stdout("Source Status");
    stdout(`Project root: ${config.sources.git.repoPath}`);
    stdout(`Conversations in SQLite: ${countWhere(store, "sources", "type = 'conversation'")}`);
    stdout(`Chunks in SQLite: ${countRows(store, "chunks")}`);
    stdout(`Memories in SQLite: promoted=${countRows(store, "memories")}, candidates=${countRows(store, "memory_candidates")}`);
    stdout(formatConversationStatus(codex.source, codex.enabled, codex.projectOnly, codex.totals));
    for (const root of codex.roots) stdout(formatRootStatus(root));
    stdout(formatConversationStatus(claude.source, claude.enabled, claude.projectOnly, claude.totals));
    for (const root of claude.roots) stdout(formatRootStatus(root));
    return 0;
  } finally {
    store.close();
  }
}

function countRows(store: MemoryStore, table: string): number {
  return (store.db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count;
}

function countWhere(store: MemoryStore, table: string, where: string): number {
  return (store.db.prepare(`select count(*) as count from ${table} where ${where}`).get() as { count: number }).count;
}

function formatConversationStatus(
  source: string,
  enabled: boolean,
  projectOnly: boolean,
  totals: { found: number; indexed: number; pending: number; ignored: number; parseFailures: number }
): string {
  return `${source}: enabled=${enabled} projectOnly=${projectOnly} found=${totals.found} indexed=${totals.indexed} pending=${totals.pending} ignored=${totals.ignored} parseFailures=${totals.parseFailures}`;
}

function formatRootStatus(root: {
  root: string;
  exists: boolean;
  found: number;
  indexed: number;
  pending: number;
  ignored: number;
  parseFailures: number;
  latestLogAt?: string | undefined;
}): string {
  return `  ${root.root}: exists=${root.exists} found=${root.found} indexed=${root.indexed} pending=${root.pending} ignored=${root.ignored} parseFailures=${root.parseFailures} latest=${root.latestLogAt ?? "n/a"}`;
}
