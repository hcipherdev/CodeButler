// Tests recordAttestation()/revokeAttestation()/mergeAttestations() in src/rules/attestations.ts and attestation-ledger.ts, verified stubs from getApplicableRules() in src/rules/match.ts, and the desktop repeat setting in src/rules/desktop.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
import { parseRuleFile, serializeRule } from "../../src/rules/format.js";
import { globalRulesRoot } from "../../src/rules/identity.js";
import { createRule, listRules, updateRule } from "../../src/rules/store.js";
import { getApplicableRules, type ServedRule } from "../../src/rules/match.js";
import { attestationsDir, listAttestations, recordAttestation, revokeAttestation } from "../../src/rules/attestations.js";
import { rulesDesktopList } from "../../src/rules/desktop.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import {
  decodeAttestationFiles, encodeAttestationFiles, mergeAttestations, ruleBodyHash, type AttestationEntry, type AttestationState
} from "../../src/rules/attestation-ledger.js";

const roots: string[] = [];
const temp = () => { const path = makeTempDir(); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root); });
function setup() { const home = temp(), project = temp(); vi.stubEnv("CODE_BUTLER_HOME", home); return { home, project, root: globalRulesRoot() }; }
const HOST = { kind: "ssh-host" as const, key: `SHA256:${"a".repeat(43)}` };
const OTHER = { kind: "ssh-host" as const, key: `SHA256:${"b".repeat(43)}` };
const DAY = 86_400_000;
const sshRule = () => createRule({ title: "SSH hardening", body: "Run the SSH hardening pre-flight.", severity: "must", triggers: { keywords: ["ssh"] }, verification: { subject: "ssh-host", ttl: "30d", recheckOn: ["sshd_config"] } });
const served = (project: string, query: Parameters<typeof getApplicableRules>[1]) => getApplicableRules(project, query).rules[0] as ServedRule;
const agentRecord = (rule: { id: string; body: string }, subject = HOST, now?: Date) =>
  recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: { ...subject, label: "deploy@web-1" }, outcome: "satisfied", evidence: "Key-only login; fail2ban active." }, { by: "agent", ...(now ? { now } : {}) });

describe("verification rule format", () => {
  it("serializes verification as schema version 2 and leaves other rules at version 1", () => {
    const text = serializeRule({ schemaVersion: 1, id: "ssh", title: "SSH", body: "Check.", verification: { subject: "ssh-host", ttl: "30d", recheckOn: ["sshd_config"] } });
    expect(text).toContain("schemaVersion: 2"); expect(text).toContain('verification:\n  subject: "ssh-host"\n  ttl: "30d"\n  recheckOn: ["sshd_config"]');
    const parsed = parseRuleFile(text, "ssh.md"); expect(parsed.ok).toBe(true);
    if (parsed.ok) { expect(parsed.rule.verification).toEqual({ subject: "ssh-host", ttl: "30d", recheckOn: ["sshd_config"] }); expect(serializeRule(parsed.rule)).toBe(text); }
    expect(serializeRule({ schemaVersion: 1, id: "plain", title: "Plain", body: "Check." })).toContain("schemaVersion: 1");
  });
  it("rejects version mismatches, unknown subjects and out-of-range ttl", () => {
    const text = serializeRule({ schemaVersion: 1, id: "ssh", title: "SSH", body: "Check.", verification: { subject: "ssh-host" } });
    expect(parseRuleFile(text.replace("schemaVersion: 2", "schemaVersion: 1"), "ssh.md").ok).toBe(false);
    expect(parseRuleFile(text.replace("schemaVersion: 2", "schemaVersion: 3"), "ssh.md").ok).toBe(false);
    expect(parseRuleFile(text.replace('"ssh-host"', '"url"'), "ssh.md").ok).toBe(false);
    expect(parseRuleFile(text.replace('"30d"', '"366d"'), "ssh.md").ok).toBe(false);
    expect(parseRuleFile(text.replace('"30d"', '"2w"'), "ssh.md").ok).toBe(false);
  });
});

describe("recording verification results", () => {
  it("accepts agent results only for opted-in rules, the current body, and allowed outcomes", async () => {
    const { project } = setup(), rule = await sshRule(), plain = await createRule({ title: "Plain", body: "No verification.", triggers: { keywords: ["ssh"] } });
    await expect(agentRecord(plain)).rejects.toThrow("does not accept recorded results");
    await expect(recordAttestation({ ruleId: "missing", ruleBodyHash: "0".repeat(64), subject: HOST, outcome: "satisfied", evidence: "x" }, { by: "agent" })).rejects.toThrow("missing");
    await expect(recordAttestation({ ruleId: rule.id, ruleBodyHash: "0".repeat(64), subject: HOST, outcome: "satisfied", evidence: "x" }, { by: "agent" })).rejects.toThrow("changed since it was read");
    await expect(recordAttestation({ ruleId: rule.id, subject: HOST, outcome: "satisfied", evidence: "x" }, { by: "agent" })).rejects.toThrow("bodyHash");
    await expect(recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: HOST, outcome: "exempt" }, { by: "agent" })).rejects.toThrow("Only the user");
    await expect(recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: { kind: "ssh-host", key: "deploy@web-1" }, outcome: "satisfied", evidence: "x" }, { by: "agent" })).rejects.toThrow("fingerprint");
    await expect(recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: { kind: "project" }, outcome: "satisfied", evidence: "x" }, { by: "agent", projectRoot: project })).rejects.toThrow("records ssh-host results");
    await expect(recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: HOST, outcome: "satisfied", evidence: "API_KEY=real-value" }, { by: "agent" })).rejects.toThrow("secret");
    const { entry } = await agentRecord(rule);
    expect(entry).toMatchObject({ outcome: "satisfied", recordedBy: "agent", ruleBodyHash: ruleBodyHash(rule), subject: { label: "deploy@web-1" } });
    expect(Date.parse(entry.expiresAt!) - Date.parse(entry.checkedAt)).toBe(30 * DAY);
    await updateRule(rule.id, { enabled: false }, listRules().rules.find(r => r.id === rule.id)!.contentHash);
    await expect(agentRecord(rule)).rejects.toThrow("disabled");
  });
  it("lets only the user exempt a subject, keeps that exemption from agents, and revokes with a tombstone", async () => {
    setup(); const rule = await sshRule();
    const user = await recordAttestation({ ruleId: rule.id, subject: HOST, outcome: "satisfied" }, { by: "user" });
    expect(Date.parse(user.entry.expiresAt!) - Date.parse(user.entry.checkedAt)).toBe(90 * DAY);
    await recordAttestation({ ruleId: rule.id, subject: OTHER, outcome: "exempt", evidence: "Managed by Ansible." }, { by: "user" });
    await expect(agentRecord(rule, OTHER)).rejects.toThrow("marked this subject exempt");
    // A newer local result always supersedes, even when the stored one is dated in the future.
    const future = new Date(Date.now() + DAY);
    await recordAttestation({ ruleId: rule.id, subject: HOST, outcome: "satisfied" }, { by: "user", now: future });
    const later = await agentRecord(rule);
    expect(Date.parse(later.entry.checkedAt)).toBeGreaterThan(future.getTime());
    await revokeAttestation(rule.id, HOST);
    await expect(revokeAttestation(rule.id, HOST)).rejects.toThrow("No recorded result");
    expect(listAttestations().attestations.map(a => [a.subject.key, a.outcome, a.valid])).toEqual([[OTHER.key, "exempt", true]]);
  });
});

describe("verified rule retrieval", () => {
  it("serves a stub only when every named subject has a valid result", async () => {
    const { project } = setup(), rule = await sshRule();
    await agentRecord(rule);
    const full = served(project, { task: "deploy over ssh" });
    expect(full.body).toBe(rule.body); expect(full.bodyHash).toBe(ruleBodyHash(rule));
    expect(full.verification).toMatchObject({ status: "needed", subjectKind: "ssh-host", ttl: "30d", knownSubjects: [{ key: HOST.key, label: "deploy@web-1", valid: true }] });
    const stub = served(project, { task: "deploy over ssh", subjects: [HOST] });
    expect(stub).toMatchObject({ id: rule.id, bodyOmitted: true, verification: { status: "verified", subjects: [{ key: HOST.key, outcome: "satisfied", evidence: "Key-only login; fail2ban active." }] } });
    expect(stub.body).toContain("Already verified for deploy@web-1");
    expect(served(project, { task: "deploy over ssh", subjects: [HOST, OTHER] }).body).toBe(rule.body);
    expect(served(project, { task: "ssh in and edit sshd_config", subjects: [HOST] })).toMatchObject({ body: rule.body, verification: { status: "needed", recheckReason: "keyword:sshd_config" } });
    const catalog = getApplicableRules(project, { mode: "catalog" }).rules[0];
    expect(catalog).toMatchObject({ id: rule.id, verifiedSubjects: 1 });
    await revokeAttestation(rule.id, HOST);
    expect(served(project, { task: "ssh", subjects: [HOST] }).body).toBe(rule.body);
  });
  it("expires satisfied results and ties them to the checked body, while exemptions survive edits", async () => {
    const { project } = setup(), rule = await sshRule();
    await agentRecord(rule, HOST, new Date(Date.now() - 40 * DAY));
    expect(served(project, { task: "ssh", subjects: [HOST] }).verification).toMatchObject({ status: "needed", knownSubjects: [{ key: HOST.key, valid: false }] });
    await agentRecord(rule, HOST);
    await recordAttestation({ ruleId: rule.id, subject: OTHER, outcome: "declined" }, { by: "user" });
    expect(served(project, { task: "ssh", subjects: [HOST, OTHER] }).bodyOmitted).toBe(true);
    const edited = await updateRule(rule.id, { body: "Run the revised SSH hardening pre-flight." }, listRules().rules.find(r => r.id === rule.id)!.contentHash);
    expect(served(project, { task: "ssh", subjects: [HOST] }).body).toBe(edited.body);
    expect(served(project, { task: "ssh", subjects: [OTHER] }).bodyOmitted).toBe(true);
  });
  it("derives project subjects from the project identity without the agent naming them", async () => {
    const { project } = setup(), other = temp();
    writeFileSync(join(project, ".code-butler-project.json"), JSON.stringify({ version: 1, projectIdentity: randomUUID() }));
    const rule = await createRule({ title: "Gitignore secrets", body: "Ensure secrets/ is ignored.", core: true, verification: { subject: "project" } });
    await recordAttestation({ ruleId: rule.id, ruleBodyHash: ruleBodyHash(rule), subject: { kind: "project" }, outcome: "satisfied", evidence: ".gitignore lists secrets/." }, { by: "agent", projectRoot: project });
    expect(served(project, {})).toMatchObject({ bodyOmitted: true, verification: { status: "verified" } });
    expect(served(other, {}).body).toBe(rule.body);
  });
  it("keeps serving rules when a recorded-results file is damaged", async () => {
    const { project, root } = setup(), rule = await sshRule();
    mkdirSync(attestationsDir(root), { recursive: true }); writeFileSync(join(attestationsDir(root), `${rule.id}.json`), "{not json");
    const page = getApplicableRules(project, { task: "ssh", subjects: [HOST] });
    expect((page.rules[0] as ServedRule).body).toBe(rule.body);
    expect(page.invalid).toMatchObject([{ file: `attestations/${rule.id}.json` }]);
  });
});

describe("desktop repeat setting", () => {
  it("turns verification on, keeps it across unrelated edits, and removes it with null", async () => {
    setup();
    const created = await handleDesktopRequest({ version: 1, action: "rules.create", expectedRevision: rulesDesktopList().revision, input: { title: "SSH", body: "Check hardening.", triggers: { keywords: ["ssh"] }, verification: { subject: "ssh-host", ttl: "30d", recheckOn: [] } } });
    expect(created).toMatchObject({ schemaVersion: 2, verification: { subject: "ssh-host" } });
    const current = () => listRules().rules[0]!;
    await handleDesktopRequest({ version: 1, action: "rules.update", id: current().id, expectedHash: current().contentHash, patch: { body: "Check hardening first." } });
    expect(current()).toMatchObject({ schemaVersion: 2, body: "Check hardening first.", verification: { subject: "ssh-host" } });
    await handleDesktopRequest({ version: 1, action: "rules.update", id: current().id, expectedHash: current().contentHash, patch: { verification: null } });
    expect(current().schemaVersion).toBe(1); expect(current().verification).toBeUndefined();
  });
});

describe("recorded results merge", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");
  const entry = (key: string, checkedAt: string, extra: Partial<AttestationEntry> = {}): AttestationEntry => ({
    subject: { kind: "ssh-host", key }, outcome: "satisfied", recordedBy: "agent", ruleBodyHash: "c".repeat(64), checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 30 * DAY).toISOString(), ...extra
  });
  const state = (...entries: AttestationEntry[]): AttestationState => new Map([["ssh", entries]]);
  it("is commutative and idempotent, with the latest result per subject winning", () => {
    const a = state(entry(HOST.key, "2026-10-01T00:00:00.000Z"), entry(OTHER.key, "2026-10-03T00:00:00.000Z"));
    const b = state(entry(HOST.key, "2026-10-02T00:00:00.000Z", { outcome: "not_satisfied" }), entry(OTHER.key, "2026-10-03T00:00:00.000Z", { evidence: "Same instant, different content." }));
    const ab = mergeAttestations([a, b], undefined, now), ba = mergeAttestations([b, a], undefined, now);
    expect(encodeAttestationFiles(ab)).toEqual(encodeAttestationFiles(ba));
    expect(encodeAttestationFiles(mergeAttestations([ab, ab], undefined, now))).toEqual(encodeAttestationFiles(ab));
    expect(ab.get("ssh")!.find(e => e.subject.key === HOST.key)!.outcome).toBe("not_satisfied");
  });
  it("prunes long-expired results, old tombstones, and deleted rules deterministically", () => {
    const merged = mergeAttestations([new Map([
      ["ssh", [
        entry(HOST.key, new Date(now.getTime() - 70 * DAY).toISOString()),
        entry(OTHER.key, new Date(now.getTime() - 50 * DAY).toISOString()),
        { subject: { kind: "ssh-host", key: `SHA256:${"c".repeat(43)}` }, outcome: "revoked", recordedBy: "user", ruleBodyHash: "c".repeat(64), checkedAt: new Date(now.getTime() - 401 * DAY).toISOString() }
      ]],
      ["deleted", [entry(HOST.key, now.toISOString())]]
    ])], new Set(["ssh"]), now);
    expect([...merged.keys()]).toEqual(["ssh"]);
    expect(merged.get("ssh")!.map(e => e.subject.key)).toEqual([OTHER.key]);
  });
  it("validates files and bounds their size", () => {
    expect(() => decodeAttestationFiles(new Map([["attestations/ssh.json", Buffer.from(JSON.stringify({ schemaVersion: 1, ruleId: "other", entries: [] }))]]))).toThrow("filename");
    expect(() => decodeAttestationFiles(new Map([["attestations/ssh.json", Buffer.from(JSON.stringify({ schemaVersion: 1, ruleId: "ssh", entries: [{ ...entry(HOST.key, now.toISOString()), outcome: "exempt", expiresAt: undefined }] }))]]))).toThrow("Only the user");
    const many = Array.from({ length: 300 }, (_, i) => entry(`SHA256:${String(i).padStart(43, "A")}`, now.toISOString(), { evidence: "x".repeat(200) }));
    expect(() => encodeAttestationFiles(state(...many))).toThrow("64 KiB");
  });
});
