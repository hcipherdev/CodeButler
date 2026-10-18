import { readFileSync } from "node:fs";
import { getApplicableRules, type RuleQuery } from "../../rules/match.js";
import { rulesDir } from "../../rules/identity.js";
import { captureRulesFiles, listRules, readRule, resolveRuleConflict } from "../../rules/store.js";
import { decodeRulesFiles, stateHash } from "../../rules/merge.js";
import { globalRulesSyncStatus, setGlobalRulesSyncEnabled, syncGlobalRules } from "../../rules/sync.js";
import { errorOutcome } from "../../cloud/outcome.js";
import { listAttestations, recordAttestation, revokeAttestation, type RecordAttestationInput } from "../../rules/attestations.js";
import { verificationSubjects } from "../../rules/format.js";

/** `ssh-host:SHA256:…` splits at the first colon; `project` alone derives the key from the current project. */
function parseSubject(value: string): { kind: typeof verificationSubjects[number]; key?: string } {
  const split = value.indexOf(":"), kind = split < 0 ? value : value.slice(0, split), key = split < 0 ? undefined : value.slice(split + 1);
  if (!(verificationSubjects as readonly string[]).includes(kind)) throw new Error(`Use --subject ${verificationSubjects.map(k => k === "project" ? k : `${k}:<key>`).join(" or ")}`);
  return { kind: kind as typeof verificationSubjects[number], ...(key ? { key } : {}) };
}
function parseFlags(rest: string[], allowed: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!allowed.includes(flag) || flags.has(flag)) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (!rest[i + 1]) throw new Error(`Missing value for ${flag}`); flags.set(flag, rest[i + 1]!);
  }
  return flags;
}

export async function runRulesCommand(args: string[], cwd: string, output: (text: string) => void): Promise<number> {
  const [command, ...rest] = args;
  const emit = (value: unknown) => output(JSON.stringify(value, null, 2));
  if (command === "path") { output(rulesDir()); return 0; }
  if (command === "list") { emit(listRules()); return 0; }
  if (command === "show") { const found = readRule(rest[0] ?? ""); if (!found) throw new Error("Rule missing, invalid, or conflicted"); emit(found); return 0; }
  if (command === "conflicts") { emit(listRules().conflicts.map(c => ({ ...c, expectedStateHash: stateHash(decodeRulesFiles(captureRulesFiles()).get(c.id)) }))); return 0; }
  if (command === "match") {
    const input: RuleQuery = { actions: [], paths: [] };
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]; if (flag === "--json") continue;
      const value = rest[++i]; if (!value) throw new Error(`Missing value for ${flag}`);
      if (flag === "--action") input.actions!.push(value as NonNullable<RuleQuery["actions"]>[number]);
      else if (flag === "--path") input.paths!.push(value);
      else if (flag === "--task") input.task = value;
      else if (flag === "--cursor") input.cursor = value;
      else if (flag === "--platform" || flag === "--shell" || flag === "--location") input.targetEnvironment = { ...input.targetEnvironment, [flag.slice(2)]: value };
      else if (flag === "--id") (input.ids ??= []).push(value);
      else if (flag === "--mode") input.mode = value as "match" | "catalog";
      else if (flag === "--subject") { const subject = parseSubject(value); if (!subject.key) throw new Error("--subject needs kind:key; project subjects are derived automatically"); (input.subjects ??= []).push({ kind: subject.kind, key: subject.key }); }
      else throw new Error(`Unknown rules match option: ${flag}`);
    }
    emit(getApplicableRules(cwd, input)); return 0;
  }
  if (command === "attestations") {
    const flags = parseFlags(rest.filter(flag => flag !== "--json"), ["--rule"]);
    emit(listAttestations(undefined, flags.get("--rule"))); return 0;
  }
  if (command === "attest") {
    const flags = parseFlags(rest.slice(1), ["--subject", "--label", "--outcome", "--ttl", "--note"]);
    const subject = flags.get("--subject"); if (!subject) throw new Error("Use --subject, for example ssh-host:SHA256:<fingerprint>");
    const label = flags.get("--label"), note = flags.get("--note"), ttl = flags.get("--ttl");
    emit(await recordAttestation({ ruleId: rest[0] ?? "", subject: { ...parseSubject(subject), ...(label ? { label } : {}) },
      outcome: (flags.get("--outcome") ?? "satisfied") as RecordAttestationInput["outcome"], ...(note ? { evidence: note } : {}), ...(ttl ? { ttl } : {}) }, { by: "user", projectRoot: cwd }));
    return 0;
  }
  if (command === "revoke") {
    const subject = parseFlags(rest.slice(1), ["--subject"]).get("--subject"); if (!subject) throw new Error("Use --subject to choose the result to revoke");
    emit(await revokeAttestation(rest[0] ?? "", parseSubject(subject), { projectRoot: cwd })); return 0;
  }
  if (command === "resolve") {
    const id = rest[0] ?? "", flags = new Map<string, string>();
    for (let i = 1; i < rest.length; i += 2) {
      const flag = rest[i]!;
      if (!["--conflict", "--expected-state", "--variant", "--file"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or duplicate resolution option: ${flag}`);
      if (!rest[i + 1]) throw new Error("Missing resolution option"); flags.set(flag, rest[i + 1]!);
    }
    if (flags.has("--file") === flags.has("--variant")) throw new Error("Choose exactly one of --variant or --file");
    const conflictId = flags.get("--conflict"), expectedStateHash = flags.get("--expected-state");
    if (!conflictId || !expectedStateHash) throw new Error("Use --conflict and --expected-state from rules conflicts to reject stale resolutions");
    await resolveRuleConflict(id, { conflictId, expectedStateHash, ...(flags.has("--file") ? { edited: readFileSync(flags.get("--file")!, "utf8") } : { variant: flags.get("--variant") ?? "" }) });
    emit({ resolved: id }); return 0;
  }
  if (command === "sync") {
    const operation = rest[0] ?? "status";
    if (operation === "status") emit(globalRulesSyncStatus());
    else if (operation === "enable" || operation === "disable") emit(await setGlobalRulesSyncEnabled(operation === "enable"));
    else if (operation === "now") {
      try {
        const result = await syncGlobalRules({ background: Boolean(process.env.CODE_BUTLER_WATCH_TOKEN) });
        emit(result);
        const outcome = result.outcome === "failed" ? "failed" : "queued" in result && result.queued ? "deferred" : "success";
        process.send?.({ type: "watch-result", stage: "cloud", outcome, ...(result.binding?.syncError ? { reason: result.binding.syncError } : {}) });
        return outcome === "failed" ? 1 : outcome === "deferred" ? 75 : 0;
      } catch (error) {
        process.send?.({ type: "watch-result", ...errorOutcome(error, "cloud") });
        throw error;
      }
    }
    else throw new Error("Use rules sync status|enable|disable|now");
    return 0;
  }
  output("code-butler rules path|list|show <id>|match|conflicts|resolve <id>|attestations|attest <id>|revoke <id>|sync status|enable|disable|now"); return command ? 1 : 0;
}
