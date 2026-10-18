// Tests hasExactLegacyV1Signature() in src/memory/legacy.ts against the reasons the retired v1 docs/config extractor actually wrote.
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { hasExactLegacyV1Signature } from "../../src/memory/legacy.js";
import { openMemoryStore } from "../../src/storage/store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const docs = {
  type: "constraint" as const,
  title: "Open — operational",
  summary: "Documentation includes Open — operational.",
  reason: "Captured from deterministic documentation change.",
  confidence: 0.6,
  evidence: [],
  relatedFiles: ["docs/issues/open-issues.md"],
  dedupeKey: "deterministic:docs:docs/issues/open-issues.md:open-operational"
};

const config = {
  type: "constraint" as const,
  title: "Config defines scripts",
  summary: "package.json defines scripts.",
  reason: "Captured from deterministic package or config file change.",
  confidence: 0.65,
  evidence: [],
  relatedFiles: ["package.json"],
  dedupeKey: "deterministic:config:package.json:scripts"
};

describe("legacy v1 extractor signature", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); });

  it("matches the reasons the retired docs and config extractors wrote", () => {
    expect(hasExactLegacyV1Signature(docs)).toBe(true);
    expect(hasExactLegacyV1Signature(config)).toBe(true);
  });

  it("rejects near matches", () => {
    expect(hasExactLegacyV1Signature({ ...docs, summary: "Documentation includes Open issues." })).toBe(false);
    expect(hasExactLegacyV1Signature({ ...docs, reason: "Edited by a reviewer." })).toBe(false);
    expect(hasExactLegacyV1Signature({ ...docs, relatedFiles: ["README.md"] })).toBe(false);
    expect(hasExactLegacyV1Signature({ ...config, summary: "package.json defines engines." })).toBe(false);
  });

  it("routes real legacy docs memories to the deterministic legacy queue after an audit", async () => {
    const project = makeTempDir();
    roots.push(project);
    const store = openMemoryStore(project);
    store.init();
    const legacy = store.upsertMemoryCandidate(docs);
    store.close();

    expect(await runCli(["memory", "audit", "--json"], { cwd: project, stdout: () => undefined })).toBe(0);
    const output: string[] = [];
    expect(await runCli([
      "memory", "reconcile", "plan", "--queue", "legacy", "--limit", "all", "--json"
    ], { cwd: project, stdout: (line) => output.push(line) })).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ requestCount: 0, items: [{ memoryId: legacy.id }] });
  });
});
