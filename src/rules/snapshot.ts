import { bundleResolver, captureSnapshot, materializeSnapshot, type SnapshotBundle, type SnapshotSegment } from "../cloud/snapshot.js";
import { contentHash, decodeRulesFiles, type RuleFiles } from "./merge.js";
import { decodeAttestationFiles, type AttestationFiles } from "./attestation-ledger.js";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_ENVELOPE } from "../cloud/encrypted-protocol.js";
import { hasStoredProjectContent } from "../storage/project-content.js";

export function validateEmptyDatabase(bytes: Buffer, resource = "Global rules"): void {
  const directory = mkdtempSync(join(tmpdir(), "butler-rules-scaffold-")), path = join(directory, "memory.sqlite");
  try {
    writeFileSync(path, bytes, { mode: 0o600 });
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      if (hasStoredProjectContent(database)) throw new Error(`${resource} transport database must be empty; project memories cannot be synchronized here`);
    } finally { database.close(); }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
}

function globalRulesBundleFiles(bundle: SnapshotBundle): { rules: RuleFiles; attestations: AttestationFiles } {
  if (bundle.manifest.segments.some(s => s.kind === "partition")) throw new Error("Global rules snapshots cannot contain project memory partitions");
  const rules: RuleFiles = new Map(), attestations: AttestationFiles = new Map();
  for (const file of materializeSnapshot(bundle.manifest, bundleResolver(bundle.blocks)).files) {
    if (file.path.startsWith("rules/")) rules.set(file.path, file.data);
    else if (file.path.startsWith("attestations/")) attestations.set(file.path, file.data);
    else if (file.path === "memory.sqlite") validateEmptyDatabase(file.data);
    else if (!["memory.sqlite", "config.json", ".gitignore", ".env.example"].includes(file.path)) throw new Error(`Unsupported global rules snapshot file: ${file.path}. Update Code Butler on this device to sync newer global rules.`);
  }
  decodeRulesFiles(rules); decodeAttestationFiles(attestations); return { rules, attestations };
}
export const rulesFilesFromBundle = (bundle: SnapshotBundle): RuleFiles => globalRulesBundleFiles(bundle).rules;
export const attestationFilesFromBundle = (bundle: SnapshotBundle): AttestationFiles => globalRulesBundleFiles(bundle).attestations;
/** Construct segments from the exact validated buffers; never read them again during encryption. */
export function withRulesFiles(bundle: SnapshotBundle, files: RuleFiles, attestations: AttestationFiles = new Map()): SnapshotBundle {
  decodeRulesFiles(files); decodeAttestationFiles(attestations);
  const core = bundle.manifest.segments.find(s => s.kind === "core"); if (!core) throw new Error("Rules snapshot database missing");
  const segments: SnapshotSegment[] = [core], blocks = new Map<string, Buffer>();
  for (const hash of core.blocks) { const bytes = bundle.blocks.get(hash); if (!bytes) throw new Error("Missing snapshot block"); blocks.set(hash, bytes); }
  for (const [path, bytes] of new Map([["config.json", Buffer.from("{}\n")], ...files, ...attestations])) {
    const hash = contentHash(bytes); if (bytes.length > 64 * 1024) throw new Error("Rules snapshot file exceeds transport limit");
    blocks.set(hash, bytes); segments.push({ id: `file:${path}`, kind: "file", fingerprint: hash, blocks: [hash], bytes: bytes.length });
  }
  const pathOf = (s: SnapshotSegment): string => s.kind === "core" ? "memory.sqlite" : s.id.slice(5);
  segments.sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  const fingerprint = contentHash(JSON.stringify(segments.map(s => [pathOf(s), s.fingerprint])));
  const manifest = { ...bundle.manifest, fingerprint, segments };
  // The decryptor bounds the expanded metadata independently of the envelope.
  const transportMetadata = JSON.stringify({ snapshot: manifest, blocks: Object.fromEntries([...blocks.keys()].map(hash => [hash, hash])) });
  if (Buffer.byteLength(transportMetadata) > MAX_ENVELOPE) throw new Error("Rules manifest exceeds the encrypted transport limit; staged variants are retained. Split or remove rules before retrying.");
  return { manifest, blocks };
}
export async function captureGlobalRulesSnapshot(root: string, projectId: string, revision: number, checkoutId: string): Promise<SnapshotBundle> {
  const captured = await captureSnapshot(root, projectId, revision, checkoutId, "none");
  const bundle = { manifest: captured.snapshot, blocks: captured.blocks };
  const { rules, attestations } = globalRulesBundleFiles(bundle);
  return withRulesFiles(bundle, rules, attestations);
}
