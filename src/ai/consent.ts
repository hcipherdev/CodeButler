import type { DatabaseSync } from "node:sqlite";

import { readRemoteModelConsent, setRemoteModelConsent } from "../config.js";
import { installationDeviceId } from "../memory/origin.js";
import type { MemoryStore } from "../storage/store.js";
import { AI_JOBS, type ProjectConfig } from "../types.js";

/** True when a job would run on the built-in default model that still waits for the person's opt-in. */
export function awaitsRemoteModelConsent(config: Pick<ProjectConfig, "extractor" | "investigator" | "models">): boolean {
  if (config.extractor.requiresConsent || config.investigator.requiresConsent) return true;
  return AI_JOBS.some(job => config.models?.[job]?.requiresConsent === true);
}

/** The same configuration with the opt-in granted, for a run that has already loaded it. */
export function withRemoteModelConsent<T extends Pick<ProjectConfig, "extractor" | "investigator" | "models">>(config: T): T {
  const clear = <M extends { requiresConsent?: boolean | undefined }>(model: M): M => {
    if (!model.requiresConsent) return model;
    const { requiresConsent: _granted, ...rest } = model;
    return rest as M;
  };
  const models = config.models
    ? Object.fromEntries(AI_JOBS.map(job => [job, clear(config.models![job])])) as NonNullable<T["models"]>
    : undefined;
  return {
    ...config,
    extractor: clear(config.extractor),
    investigator: clear(config.investigator),
    ...(models ? { models } : {})
  };
}

/**
 * Before opt-in existed, an exported provider key alone switched extraction on. A project where
 * that already happened on this device keeps working: its consent is recorded once, locally.
 */
export function migrateRemoteModelConsent<T extends Pick<ProjectConfig, "extractor" | "investigator" | "models">>(
  store: Pick<MemoryStore, "db" | "localDb" | "paths">,
  config: T,
  deviceId: () => string = () => installationDeviceId()
): T {
  if (!awaitsRemoteModelConsent(config)) return config;
  const root = store.paths.rootDir;
  if (readRemoteModelConsent(root) !== undefined) return config;
  if (!extractionRanHere(store, deviceId)) return config;
  setRemoteModelConsent(root, true);
  return withRemoteModelConsent(config);
}

function extractionRanHere(store: Pick<MemoryStore, "db" | "localDb">, deviceId: () => string): boolean {
  if (tableExists(store.localDb, "extraction_runs")
    && store.localDb.prepare("select 1 from extraction_runs where error is null limit 1").get()) return true;
  // Extraction runs are pruned with other local artifacts; the memories it produced here remain.
  return tableExists(store.db, "memory_candidates") && store.db.prepare(
    `select 1 from memory_candidates
     where origin_json is not null and json_valid(origin_json)
       and json_extract(origin_json, '$.method') = 'llm' and json_extract(origin_json, '$.deviceId') = ?
     limit 1`
  ).get(deviceId()) !== undefined;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !== undefined;
}
