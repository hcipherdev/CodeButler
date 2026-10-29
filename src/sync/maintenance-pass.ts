import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicJson, readJson, stateDirectory } from "../cloud/state.js";
import { PROMOTION_POLICY_VERSION } from "../memory/automatic-promotion.js";
import { readGitRefsFingerprint } from "../memory/branch-state.js";
import { RETENTION_POLICY_VERSION } from "../memory/layer-retention.js";
import { canonicalRevisionParts } from "../retrieval/canonical-revision.js";
import { buildInfo } from "../runtime.js";
import type { MemoryStore } from "../storage/store.js";
import type { ProjectConfig } from "../types.js";

/** Time-based thresholds (idle, grace and stale days) still fire within this bound while nothing else changes. */
export const MAINTENANCE_RERUN_MS = 60 * 60 * 1000;

interface MaintenancePassRecord {
  version: 1;
  inputs: string;
  revision: string;
  ranAt: string;
}

export interface MaintenancePassCheck {
  due: boolean;
  /** Absent when the inputs could not be read; such a pass runs and records nothing. */
  inputs?: string;
}

function recordPath(store: MemoryStore): string {
  // Device-local checkout state: never synced and never part of the project folder.
  return join(stateDirectory(store.paths.rootDir), "maintenance-pass.json");
}

/** Everything automatic promotion and layer retention read besides canonical rows and the clock. */
function maintenanceInputs(config: ProjectConfig): string {
  return createHash("sha256").update(JSON.stringify({
    config,
    git: readGitRefsFingerprint(config.sources.git.repoPath),
    promotionPolicy: PROMOTION_POLICY_VERSION,
    retentionPolicy: RETENTION_POLICY_VERSION,
    build: [buildInfo.version, buildInfo.buildId, buildInfo.builtAt]
  })).digest("hex");
}

/**
 * Journaled tables whose changes promotion, retention and invalidations do not read. A
 * session that is still being written re-imports its messages on every pass; counting
 * those rows made the passes rerun each time. Changes that do matter, such as a rewritten
 * cited message, are still picked up by the MAINTENANCE_RERUN_MS bound.
 */
const SOURCE_SIDE_ENTITIES = ["chunks", "sources", "temporary_memories", "sync_sources"];

/** The canonical revision as maintenance sees it: memory-side changes only. */
export function maintenanceRevision(store: MemoryStore): string {
  const { identity, policy } = canonicalRevisionParts(store);
  const row = store.db.prepare(
    `select sequence from retrieval_changes where entity not in (${SOURCE_SIDE_ENTITIES.map(() => "?").join(", ")})
      order by sequence desc limit 1`
  ).get(...SOURCE_SIDE_ENTITIES) as { sequence: number } | undefined;
  return `${identity}:${Number(row?.sequence ?? 0)}:${policy}`;
}

/**
 * The watcher's promotion and retention passes scan every memory under the project gate.
 * They are due again only when canonical rows, config, git branches, policy or the build
 * changed since the last pass, or when the last pass is older than MAINTENANCE_RERUN_MS.
 */
export function checkMaintenancePass(store: MemoryStore, config: ProjectConfig, now = new Date()): MaintenancePassCheck {
  try {
    const inputs = maintenanceInputs(config);
    const record = readJson<MaintenancePassRecord>(recordPath(store));
    const ranAt = record ? Date.parse(record.ranAt) : Number.NaN;
    const fresh = record?.version === 1 && record.inputs === inputs && Number.isFinite(ranAt) &&
      now.getTime() - ranAt >= 0 && now.getTime() - ranAt < MAINTENANCE_RERUN_MS &&
      record.revision === maintenanceRevision(store);
    return { due: !fresh, inputs };
  } catch {
    return { due: true };
  }
}

/** Records the revision after the passes, since their own writes move the change sequence. */
export function recordMaintenancePass(store: MemoryStore, inputs: string, now = new Date()): void {
  try {
    atomicJson(recordPath(store), {
      version: 1, inputs, revision: maintenanceRevision(store), ranAt: now.toISOString()
    } satisfies MaintenancePassRecord);
  } catch { /* Without a record the next pass simply runs again. */ }
}
