import { normalizeScope, scopeLabel } from "../../memory/scope.js";
import { updateMemoryScope } from "../../memory/scope-service.js";
import { formatMemoryOrigin } from "../../memory/origin.js";
import { auditMemoryConflicts } from "../../memory/conflicts.js";
import { updateMemoryStatus } from "../../memory/lifecycle-service.js";
import { auditMemoryQuality } from "../../memory/quality.js";
import { rememberProjectMemory } from "../../memory/remember.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";
import type { MemoryLifecycleStatus, MemoryType } from "../../types.js";

export async function runMemoryCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined } = {}
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "audit" && subcommand !== "remember" && subcommand !== "status" && subcommand !== "conflicts" && subcommand !== "scope") {
    throw new Error("Usage: code-butler memory <audit|remember|scope|status|conflicts> ...");
  }
  if (subcommand === "scope") {
    const allowed = new Set(["--id", "--category", "--scope-json", "--reason"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && arg !== "--json");
    if (unknownFlag) throw new Error(`Unknown memory scope option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory scope", valueFlags: allowed, booleanFlags: new Set(["--json"]) });
    const id = parseStringFlag(rest, "--id");
    const category = parseStringFlag(rest, "--category");
    const raw = parseStringFlag(rest, "--scope-json");
    const reason = parseStringFlag(rest, "--reason");
    if (!id || !raw || !reason || !["candidate", "promoted", "temporary"].includes(category ?? "")) throw new Error("Usage: memory scope --id <id> --category <candidate|promoted|temporary> --scope-json <json> --reason <text> [--json]");
    const scope = normalizeScope(JSON.parse(raw));
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const result = updateMemoryScope(store, { memoryId: id, category: category as "candidate" | "promoted" | "temporary", scope, reason }, "cli");
      stdout(rest.includes("--json") ? JSON.stringify(result, null, 2) : `Updated scope for ${result.memoryId}: ${scopeLabel(scope)}`);
      return 0;
    } finally { store.close(); }
  }
  if (subcommand === "remember") {
    const rawScope = parseStringFlag(rest, "--scope-json");
    const scope = rawScope === undefined ? undefined : normalizeScope(JSON.parse(rawScope));
    const type = parseMemoryTypeFlag(rest, "--type");
    const text = parseStringFlag(rest, "--text");
    const title = parseStringFlag(rest, "--title");
    const reason = parseStringFlag(rest, "--reason");
    const relatedFiles = parseRepeatedStringFlag(rest, "--related-file");
    const supersedesMemoryId = parseStringFlag(rest, "--supersedes");
    const promote = !rest.includes("--candidate");
    const allowedFlags = new Set(["--type", "--text", "--title", "--reason", "--related-file", "--candidate", "--supersedes", "--json", "--scope-json"]);
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && !allowedFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory remember option: ${unknownFlag}`);
    validateFlagArguments(rest, {
      command: "memory remember",
      valueFlags: new Set(["--type", "--text", "--title", "--reason", "--related-file", "--supersedes", "--scope-json"]),
      booleanFlags: new Set(["--candidate", "--json"])
    });
    if (!type || !text) {
      throw new Error(
        "Usage: code-butler memory remember --type <decision|constraint|bug_fix|rejected_approach> --text <text> [--title <title>] [--reason <reason>] [--related-file <path>] [--candidate] [--supersedes <memory-id>] [--scope-json <json>] [--json]"
      );
    }
    if (!promote && supersedesMemoryId !== undefined) {
      throw new Error("Superseding a durable memory requires promotion");
    }
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const remembered = rememberProjectMemory(store, {
        type,
        ...(scope === undefined ? {} : { scope }),
        text,
        ...(title === undefined ? {} : { title }),
        ...(reason === undefined ? {} : { reason }),
        relatedFiles,
        promote,
        ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId })
      }, {
        ...(options.now === undefined ? {} : { now: options.now }),
        actor: "cli"
      });
      if (rest.includes("--json")) stdout(JSON.stringify(remembered, null, 2));
      else {
        stdout(`Remembered ${type} memory ${remembered.memory?.id ?? remembered.candidate.id} (${remembered.memory ? "promoted" : "candidate"})`);
        stdout(scopeLabel((remembered.memory ?? remembered.candidate).scope));
        stdout(formatMemoryOrigin((remembered.memory ?? remembered.candidate).origin));
      }
      return 0;
    } finally {
      store.close();
    }
  }
  if (subcommand === "status") {
    const allowedFlags = new Set(["--id", "--status", "--reason", "--replacement"]);
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && !allowedFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory status option: ${unknownFlag}`);
    validateFlagArguments(rest, {
      command: "memory status",
      valueFlags: allowedFlags,
      booleanFlags: new Set()
    });
    const memoryId = parseStringFlag(rest, "--id");
    const status = parseMemoryLifecycleStatusFlag(rest, "--status");
    const rawReason = parseStringFlag(rest, "--reason");
    const reason = rawReason?.trim();
    const replacementMemoryId = parseStringFlag(rest, "--replacement");
    if (!memoryId || !status || !reason) {
      if (rawReason !== undefined && !reason) throw new Error("Lifecycle status reason is required");
      throw new Error("Usage: code-butler memory status --id <id> --status <current|superseded|retracted> --reason <text> [--replacement <id>]");
    }
    if (status === "superseded" && replacementMemoryId === undefined) {
      throw new Error("Superseded status requires --replacement");
    }
    if (status !== "superseded" && replacementMemoryId !== undefined) {
      throw new Error("--replacement is only allowed with superseded status");
    }
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const memory = updateMemoryStatus(store, {
        memoryId,
        status,
        reason,
        ...(replacementMemoryId === undefined ? {} : { replacementMemoryId }),
        now: (options.now?.() ?? new Date()).toISOString(),
        actor: "cli"
      });
      const relationCount = store.listMemoryRelations().filter((relation) =>
        relation.fromMemoryId === memory.id || relation.toMemoryId === memory.id
      ).length;
      stdout(`Memory ${memory.id} status=${memory.lifecycleStatus} replacement=${replacementMemoryId ?? "none"} relations=${relationCount}`);
      return 0;
    } finally {
      store.close();
    }
  }
  if (subcommand === "conflicts") {
    const allowedFlags = new Set(["--fix", "--json"]);
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && !allowedFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory conflicts option: ${unknownFlag}`);
    validateFlagArguments(rest, {
      command: "memory conflicts",
      valueFlags: new Set(),
      booleanFlags: allowedFlags
    });
    const fix = rest.includes("--fix");
    const json = rest.includes("--json");
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const result = auditMemoryConflicts(store, {
        fix,
        ...(options.now === undefined ? {} : { now: options.now().toISOString() })
      });
      if (json) stdout(JSON.stringify(result, null, 2));
      else {
        const additions = result.changes.filter((change) => change.kind === "add_relation").length;
        const removals = result.changes.filter((change) => change.kind === "remove_relation").length;
        const updates = result.changes.filter((change) => change.kind === "update_quality").length;
        stdout("Memory Conflicts");
        stdout(`scanned=${result.scannedMemories} groups=${result.scannedGroups} conflicts=${result.conflictPairs.length} add=${additions} remove=${removals} change=${updates} applied=${fix ? "yes" : "no"}`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
  const fix = rest.includes("--fix");
  const json = rest.includes("--json");
  const unknownFlag = rest.find((arg) => arg.startsWith("--") && arg !== "--fix" && arg !== "--json");
  if (unknownFlag) throw new Error(`Unknown memory audit option: ${unknownFlag}`);
  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    const result = auditMemoryQuality(store, { fix });
    if (json) stdout(JSON.stringify(result, null, 2));
    else {
      stdout("Memory Audit");
      stdout(`scanned=${result.scanned} active=${result.active} needs_review=${result.needsReview} quarantined=${result.quarantined} updated=${result.updated}`);
      for (const item of result.topReasons) stdout(`reason ${item.reason}=${item.count}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseRepeatedStringFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined) values.push(args[index + 1]!);
  }
  return values;
}

function parseMemoryTypeFlag(args: string[], flag: string): MemoryType | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "decision" || value === "constraint" || value === "bug_fix" || value === "rejected_approach") {
    return value;
  }
  throw new Error("--type must be one of decision, constraint, bug_fix, rejected_approach");
}

function parseMemoryLifecycleStatusFlag(args: string[], flag: string): MemoryLifecycleStatus | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "current" || value === "superseded" || value === "retracted") return value;
  throw new Error("--status must be one of current, superseded, retracted");
}

function validateFlagArguments(
  args: string[],
  input: { command: string; valueFlags: ReadonlySet<string>; booleanFlags: ReadonlySet<string> }
): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (input.booleanFlags.has(arg)) continue;
    if (!input.valueFlags.has(arg)) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg} in ${input.command}`);
    }
    index += 1;
  }
}
