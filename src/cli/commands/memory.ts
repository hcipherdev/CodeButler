import { normalizeScope, scopeLabel } from "../../memory/scope.js";
import { defaultBranchMemoryLayer } from "../../memory/branch.js";
import { layerLabel, normalizeLayer, normalizeLayerInput } from "../../memory/layer.js";
import { updateMemoryLayer } from "../../memory/layer-service.js";
import { suggestMemoryLayerPromotions } from "../../memory/layer-promotion.js";
import { listPromotionDecisions, runAutomaticPromotions } from "../../memory/automatic-promotion.js";
import {
  listLayerRetentionDecisions,
  planLayerRetention,
  runLayerRetention
} from "../../memory/layer-retention.js";
import { resolveBranchMemoryTriage, suggestBranchMemoryTriage } from "../../memory/branch-triage.js";
import { updateMemoryScope } from "../../memory/scope-service.js";
import { formatMemoryOrigin } from "../../memory/origin.js";
import { auditMemoryConflicts } from "../../memory/conflicts.js";
import { updateMemoryStatus } from "../../memory/lifecycle-service.js";
import { auditMemoryQuality } from "../../memory/quality.js";
import { rememberProjectMemory } from "../../memory/remember.js";
import { loadProjectConfig } from "../../config.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";
import type { MemoryLayerFilter, MemoryLifecycleStatus, MemoryType } from "../../types.js";

export async function runMemoryCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined } = {}
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "audit" && subcommand !== "remember" && subcommand !== "status" && subcommand !== "conflicts" && subcommand !== "scope" && subcommand !== "layer" && subcommand !== "promotions" && subcommand !== "retention" && subcommand !== "branch-triage" && subcommand !== "branch-resolve") {
    throw new Error("Usage: code-butler memory <audit|remember|scope|layer|promotions|retention|branch-triage|branch-resolve|status|conflicts> ...");
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
  if (subcommand === "layer") {
    const allowed = new Set(["--id", "--category", "--layer", "--reason"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && arg !== "--json");
    if (unknownFlag) throw new Error(`Unknown memory layer option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory layer", valueFlags: allowed, booleanFlags: new Set(["--json"]) });
    const id = parseStringFlag(rest, "--id");
    const category = parseStringFlag(rest, "--category");
    const rawLayer = parseStringFlag(rest, "--layer");
    const reason = parseStringFlag(rest, "--reason");
    if (!id || !rawLayer || !reason || !["candidate", "promoted", "temporary"].includes(category ?? "")) {
      throw new Error("Usage: memory layer --id <id> --category <candidate|promoted|temporary> --layer <core|device|device:<uuid>|branch:<name>|branch:<name>:device:<uuid>> --reason <text> [--json]");
    }
    const layer = normalizeLayerInput(rawLayer);
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const result = updateMemoryLayer(store, { memoryId: id, category: category as "candidate" | "promoted" | "temporary", layer, reason }, "cli");
      stdout(rest.includes("--json") ? JSON.stringify(result, null, 2) : `Updated layer for ${result.memoryId}: ${layerLabel(result.layer)}`);
      return 0;
    } finally { store.close(); }
  }
  if (subcommand === "promotions") {
    const allowed = new Set(["--layer", "--min-score", "--min-confidence", "--limit", "--id"]);
    const booleanFlags = new Set(["--json", "--promoted-only", "--apply", "--history"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && !booleanFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory promotions option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory promotions", valueFlags: allowed, booleanFlags });
    if (rest.includes("--apply") && rest.includes("--history")) {
      throw new Error("Use either --apply or --history, not both");
    }
    if (rest.includes("--history")) return promotionHistory(cwd, rest, stdout);
    if (rest.includes("--apply")) return applyPromotions(cwd, rest, stdout, options);
    const layer = parseLayerFilterFlag(rest, "--layer");
    const minScore = parseUnitIntervalFlag(rest, "--min-score");
    const minConfidence = parseUnitIntervalFlag(rest, "--min-confidence");
    const limit = parsePositiveIntegerFlag(rest, "--limit");
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const result = suggestMemoryLayerPromotions(store, {
        ...(layer === undefined ? {} : { layer }),
        ...(minScore === undefined ? {} : { minScore }),
        ...(minConfidence === undefined ? {} : { minConfidence }),
        ...(limit === undefined ? {} : { limit }),
        includeCandidates: !rest.includes("--promoted-only")
      });
      if (rest.includes("--json")) stdout(JSON.stringify(result, null, 2));
      else {
        stdout("Memory Layer Promotion Suggestions");
        stdout(`scanned=${result.scanned} eligible=${result.eligible} suggestions=${result.suggestions.length}`);
        for (const suggestion of result.suggestions) {
          stdout(`${suggestion.score.toFixed(2)} ${suggestion.category} ${suggestion.memoryId}: ${suggestion.title}`);
          stdout(`  ${suggestion.currentLayerLabel} -> Core (shared across devices)`);
          stdout(`  reason: ${suggestion.suggestedReason}`);
        }
      }
      return 0;
    } finally { store.close(); }
  }
  if (subcommand === "retention") {
    const allowed = new Set(["--limit", "--id"]);
    const booleanFlags = new Set(["--json", "--apply", "--history"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && !booleanFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory retention option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory retention", valueFlags: allowed, booleanFlags });
    if (rest.includes("--apply") && rest.includes("--history")) {
      throw new Error("Use either --apply or --history, not both");
    }
    if (rest.includes("--history")) return retentionHistory(cwd, rest, stdout);
    if (rest.includes("--apply")) return applyRetention(cwd, rest, stdout, options);
    const config = loadProjectConfig(cwd);
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const plan = planLayerRetention(store, config, {
        repoPath: config.sources.git.repoPath,
        ...(options.now === undefined ? {} : { now: options.now().toISOString() })
      });
      if (rest.includes("--json")) stdout(JSON.stringify(plan, null, 2));
      else {
        stdout("Memory Layer Retention");
        stdout(`enabled=${plan.enabled} scanned=${plan.scanned} policy=v${plan.policyVersion}`);
        for (const decision of plan.decisions) {
          stdout(`${decision.decision} ${decision.category} ${decision.memoryId}: ${decision.title}`);
          stdout(`  ${decision.layerLabel} idle=${decision.idleDays}d reasons: ${decision.reasonCodes.join(", ")}`);
        }
      }
      return 0;
    } finally { store.close(); }
  }
  if (subcommand === "branch-triage") {
    const allowed = new Set(["--branch", "--stale-days", "--limit"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && arg !== "--json" && arg !== "--include-active" && arg !== "--include-reviewed");
    if (unknownFlag) throw new Error(`Unknown memory branch-triage option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory branch-triage", valueFlags: allowed, booleanFlags: new Set(["--json", "--include-active", "--include-reviewed"]) });
    const branch = parseStringFlag(rest, "--branch");
    const staleDays = parsePositiveIntegerFlag(rest, "--stale-days");
    const limit = parsePositiveIntegerFlag(rest, "--limit");
    const config = loadProjectConfig(cwd);
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const result = suggestBranchMemoryTriage(store, {
        repoPath: config.sources.git.repoPath,
        ...(branch === undefined ? {} : { branch }),
        includeActive: rest.includes("--include-active"),
        includeReviewed: rest.includes("--include-reviewed"),
        ...(staleDays === undefined ? {} : { staleDays }),
        ...(limit === undefined ? {} : { limit }),
        ...(options.now === undefined ? {} : { now: options.now().toISOString() })
      });
      if (rest.includes("--json")) stdout(JSON.stringify(result, null, 2));
      else {
        stdout("Branch Memory Triage");
        stdout(`scanned=${result.scanned} eligible=${result.eligible} reviewed_hidden=${result.reviewedHidden} suggestions=${result.suggestions.length}`);
        for (const suggestion of result.suggestions) {
          stdout(`${suggestion.score.toFixed(2)} ${suggestion.branchState} ${suggestion.category} ${suggestion.memoryId}: ${suggestion.title}`);
          stdout(`  ${suggestion.layerLabel} -> ${suggestion.recommendedAction}`);
          stdout(`  reason: ${suggestion.suggestedReason}`);
        }
      }
      return 0;
    } finally { store.close(); }
  }
  if (subcommand === "branch-resolve") {
    const allowed = new Set(["--id", "--category", "--action", "--reason", "--supersedes"]);
    const unknownFlag = rest.find(arg => arg.startsWith("--") && !allowed.has(arg) && arg !== "--json");
    if (unknownFlag) throw new Error(`Unknown memory branch-resolve option: ${unknownFlag}`);
    validateFlagArguments(rest, { command: "memory branch-resolve", valueFlags: allowed, booleanFlags: new Set(["--json"]) });
    const id = parseStringFlag(rest, "--id");
    const category = parseBranchTriageCategoryFlag(rest, "--category");
    const action = parseBranchTriageActionFlag(rest, "--action");
    const rawReason = parseStringFlag(rest, "--reason");
    const reason = rawReason?.trim();
    const supersedesMemoryId = parseStringFlag(rest, "--supersedes");
    if (!id || !category || !action || !reason) {
      if (rawReason !== undefined && !reason) throw new Error("Branch triage reason is required");
      throw new Error("Usage: code-butler memory branch-resolve --id <id> --category <candidate|promoted> --action <promote_to_core|discard|retain_branch> --reason <text> [--supersedes <memory-id>] [--json]");
    }
    const store = openConfiguredMemoryStore(cwd); store.init();
    try {
      const result = resolveBranchMemoryTriage(store, {
        memoryId: id,
        category,
        action,
        reason,
        ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
        ...(options.now === undefined ? {} : { now: options.now().toISOString() })
      }, "cli");
      if (rest.includes("--json")) stdout(JSON.stringify(result, null, 2));
      else stdout(`Resolved branch memory ${result.memoryId}: ${result.action} (${result.branch})`);
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
    const layer = parseStringFlag(rest, "--layer");
    const promote = !rest.includes("--candidate");
    const allowedFlags = new Set(["--type", "--text", "--title", "--reason", "--related-file", "--candidate", "--supersedes", "--json", "--scope-json", "--layer"]);
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && !allowedFlags.has(arg));
    if (unknownFlag) throw new Error(`Unknown memory remember option: ${unknownFlag}`);
    validateFlagArguments(rest, {
      command: "memory remember",
      valueFlags: new Set(["--type", "--text", "--title", "--reason", "--related-file", "--supersedes", "--scope-json", "--layer"]),
      booleanFlags: new Set(["--candidate", "--json"])
    });
    if (!type || !text) {
      throw new Error(
        "Usage: code-butler memory remember --type <decision|constraint|bug_fix|rejected_approach> --text <text> [--title <title>] [--reason <reason>] [--related-file <path>] [--candidate] [--supersedes <memory-id>] [--scope-json <json>] [--layer <core|device:<id>|branch:<name>>] [--json]"
      );
    }
    if (!promote && supersedesMemoryId !== undefined) {
      throw new Error("Superseding a durable memory requires promotion");
    }
    const config = loadProjectConfig(cwd);
    const defaultLayer = defaultBranchMemoryLayer(config.sources.git.repoPath);
    const store = openConfiguredMemoryStore(cwd);
    store.init();
    try {
      const remembered = rememberProjectMemory(store, {
        type,
        ...(scope === undefined ? {} : { scope }),
        ...(layer === undefined ? {} : { layer: normalizeLayer(layer) }),
        text,
        ...(title === undefined ? {} : { title }),
        ...(reason === undefined ? {} : { reason }),
        relatedFiles,
        promote,
        ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId })
      }, {
        ...(options.now === undefined ? {} : { now: options.now }),
        actor: "cli",
        ...(defaultLayer === undefined ? {} : { defaultLayer })
      });
      if (rest.includes("--json")) stdout(JSON.stringify(remembered, null, 2));
      else {
        stdout(`Remembered ${type} memory ${remembered.memory?.id ?? remembered.candidate.id} (${remembered.memory ? "promoted" : "candidate"})`);
        stdout(scopeLabel((remembered.memory ?? remembered.candidate).scope));
        stdout(layerLabel((remembered.memory ?? remembered.candidate).layer));
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

function parseBranchTriageCategoryFlag(args: string[], flag: string): "candidate" | "promoted" | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "candidate" || value === "promoted") return value;
  throw new Error(`${flag} must be one of candidate, promoted`);
}

function parseBranchTriageActionFlag(args: string[], flag: string): "promote_to_core" | "discard" | "retain_branch" | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "promote_to_core" || value === "discard" || value === "retain_branch") return value;
  throw new Error(`${flag} must be one of promote_to_core, discard, retain_branch`);
}

function parseLayerFilterFlag(args: string[], flag: string): MemoryLayerFilter | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  if (value === "core" || value === "device" || value === "branch" || value === "all") return value;
  throw new Error(`${flag} must be one of core, device, branch, all`);
}

function applyPromotions(
  cwd: string,
  rest: string[],
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined }
): number {
  const config = loadProjectConfig(cwd);
  const store = openConfiguredMemoryStore(cwd); store.init();
  try {
    const minScore = parseUnitIntervalFlag(rest, "--min-score");
    const summary = runAutomaticPromotions(store, config, {
      repoPath: config.sources.git.repoPath,
      ...(options.now === undefined ? {} : { now: options.now().toISOString() }),
      ...(minScore === undefined ? {} : { automatic: { minScore } })
    }, "cli");
    if (rest.includes("--json")) stdout(JSON.stringify(summary, null, 2));
    else {
      stdout("Automatic Memory Promotion");
      stdout(
        `scanned=${summary.scanned} promoted=${summary.promoted} converged=${summary.converged} ` +
        `deferred=${summary.deferred} skipped=${summary.skipped}`
      );
      for (const warning of summary.warnings) stdout(`  warning: ${warning}`);
    }
    return 0;
  } finally { store.close(); }
}

function promotionHistory(cwd: string, rest: string[], stdout: (line: string) => void): number {
  const store = openConfiguredMemoryStore(cwd); store.init();
  try {
    const memoryId = parseStringFlag(rest, "--id");
    const limit = parsePositiveIntegerFlag(rest, "--limit");
    const history = listPromotionDecisions(store, {
      ...(memoryId === undefined ? {} : { memoryId }),
      ...(limit === undefined ? {} : { limit })
    });
    if (rest.includes("--json")) stdout(JSON.stringify(history, null, 2));
    else {
      stdout("Automatic Memory Promotion History");
      stdout(`decisions=${history.length}`);
      for (const record of history) {
        stdout(`${record.decidedAt} ${record.decision} ${record.category} ${record.memoryId}`);
        stdout(`  policy=v${record.policyVersion} reasons: ${record.reasonCodes.join(", ")}`);
      }
    }
    return 0;
  } finally { store.close(); }
}

function applyRetention(
  cwd: string,
  rest: string[],
  stdout: (line: string) => void,
  options: { now?: (() => Date) | undefined }
): number {
  const config = loadProjectConfig(cwd);
  const store = openConfiguredMemoryStore(cwd); store.init();
  try {
    const summary = runLayerRetention(store, config, {
      repoPath: config.sources.git.repoPath,
      ...(options.now === undefined ? {} : { now: options.now().toISOString() })
    }, "cli");
    if (rest.includes("--json")) stdout(JSON.stringify(summary, null, 2));
    else {
      stdout("Memory Layer Retention");
      stdout(`scanned=${summary.scanned} archived=${summary.archived} skipped=${summary.skipped}`);
      for (const warning of summary.warnings) stdout(`  warning: ${warning}`);
    }
    return 0;
  } finally { store.close(); }
}

function retentionHistory(cwd: string, rest: string[], stdout: (line: string) => void): number {
  const store = openConfiguredMemoryStore(cwd); store.init();
  try {
    const memoryId = parseStringFlag(rest, "--id");
    const limit = parsePositiveIntegerFlag(rest, "--limit");
    const history = listLayerRetentionDecisions(store, {
      ...(memoryId === undefined ? {} : { memoryId }),
      ...(limit === undefined ? {} : { limit })
    });
    if (rest.includes("--json")) stdout(JSON.stringify(history, null, 2));
    else {
      stdout("Memory Layer Retention History");
      stdout(`decisions=${history.length}`);
      for (const record of history) {
        stdout(`${record.decidedAt} ${record.decision} ${record.category} ${record.memoryId}`);
        stdout(`  policy=v${record.policyVersion} layer=${record.layer} reasons: ${record.reasonCodes.join(", ")}`);
      }
    }
    return 0;
  } finally { store.close(); }
}

function parseUnitIntervalFlag(args: string[], flag: string): number | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${flag} must be between 0 and 1`);
  return parsed;
}

function parsePositiveIntegerFlag(args: string[], flag: string): number | undefined {
  const value = parseStringFlag(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
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
