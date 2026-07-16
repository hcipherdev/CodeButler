import type { DatabaseSync } from "node:sqlite";

import type { EvidenceRef, SourceType } from "../types.js";

export function rebuildPrivacyDerivedIndexes(db: DatabaseSync): void {
  db.exec(`
    delete from chunks_fts;
    insert into chunks_fts (chunk_id, source_id, source_type, title, text)
    select c.id, c.source_id, s.type, s.title, c.text
    from chunks c join sources s on s.id = c.source_id;
    delete from temporary_memories_fts;
    insert into temporary_memories_fts
      (memory_id, project_id, thread_id, session_id, kind, title, summary, details)
    select id, project_id, thread_id, session_id, kind, title, summary, details
    from temporary_memories;
  `);
}

export function assertPrivacyDatabaseIntegrity(db: DatabaseSync): void {
  const quick = db.prepare("pragma quick_check").get() as { quick_check: string };
  if (quick.quick_check !== "ok") throw new Error(`Database failed quick_check: ${quick.quick_check}`);
  const foreignKeys = db.prepare("pragma foreign_key_check").all();
  if (foreignKeys.length > 0) throw new Error("Database failed foreign_key_check");
}

export function validatePrivacyLogicalReferences(db: DatabaseSync): void {
  const invalid = [
    db.prepare(
      `select count(*) as count from relations r
       where (r.from_type = 'source' and not exists (select 1 from sources s where s.id = r.from_id))
          or (r.from_type = 'chunk' and not exists (select 1 from chunks c where c.id = r.from_id))
          or (r.to_type in ('conversation','commit','decision') and not exists (
            select 1 from sources s where s.id = r.to_id and s.type = r.to_type
          ))
          or (r.to_type = 'chunk' and not exists (select 1 from chunks c where c.id = r.to_id))`
    ).get() as { count: number },
    db.prepare(
      `select count(*) as count from memory_links l
       where (l.owner_kind = 'candidate' and not exists (
               select 1 from memory_candidates c where c.id = l.owner_id
             ))
          or (l.owner_kind = 'memory' and not exists (
               select 1 from memories m where m.id = l.owner_id
             ))
          or (l.target_type in ('conversation','commit','decision') and not exists (
               select 1 from sources s where s.id = l.target_id and s.type = l.target_type
             ))
          or (l.target_type = 'chunk' and not exists (
               select 1 from chunks c where c.id = l.target_id
             ))`
    ).get() as { count: number },
    db.prepare(
      `select count(*) as count from temporary_memory_links l
       where not exists (select 1 from temporary_memories m where m.id = l.memory_id)
          or (l.target_type in ('conversation','commit','decision') and not exists (
               select 1 from sources s where s.id = l.target_id and s.type = l.target_type
             ))
          or (l.target_type = 'chunk' and not exists (
               select 1 from chunks c where c.id = l.target_id
             ))`
    ).get() as { count: number }
  ].reduce((sum, row) => sum + row.count, 0);
  if (invalid > 0) throw new Error(`Privacy import contains ${invalid} dangling logical references`);
}

export function validatePrivacyExportLogicalReferences(
  tables: Record<string, Array<Record<string, unknown>>>
): void {
  const sources = new Set((tables.sources ?? []).flatMap((row) =>
    typeof row.id === "string" && isSourceType(row.type) ? [`${row.type}:${row.id}`] : []
  ));
  const chunks = new Map((tables.chunks ?? []).flatMap((row) =>
    typeof row.id === "string" && typeof row.source_id === "string"
      ? [[row.id, row.source_id] as const]
      : []
  ));
  const memories = new Set((tables.memories ?? []).flatMap((row) =>
    typeof row.id === "string" ? [row.id] : []
  ));
  let invalid = 0;
  for (const table of ["decisions", "memory_candidates", "memories", "temporary_memories"]) {
    for (const row of tables[table] ?? []) {
      const evidence = parseExportEvidence(row.evidence_json);
      if (!evidence) {
        invalid += 1;
        continue;
      }
      for (const item of evidence) {
        if (!sources.has(`${item.sourceType}:${item.sourceId}`)) invalid += 1;
        if (item.locator !== undefined && chunks.get(item.locator) !== item.sourceId) invalid += 1;
      }
    }
  }
  for (const candidate of tables.memory_candidates ?? []) {
    const promotedMemoryId = candidate.promoted_memory_id;
    if (promotedMemoryId !== null && promotedMemoryId !== undefined &&
        (typeof promotedMemoryId !== "string" || !memories.has(promotedMemoryId))) {
      invalid += 1;
    }
    if (candidate.promotion_state === "promoted" &&
        (typeof promotedMemoryId !== "string" || !memories.has(promotedMemoryId))) {
      invalid += 1;
    }
  }
  if (invalid > 0) throw new Error(`Privacy import contains ${invalid} dangling logical references`);
}

function parseExportEvidence(value: unknown): EvidenceRef[] | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const evidence: EvidenceRef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (!isSourceType(record.sourceType) || typeof record.sourceId !== "string" ||
        (record.locator !== undefined && typeof record.locator !== "string")) {
      return undefined;
    }
    evidence.push({
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      ...(typeof record.locator === "string" ? { locator: record.locator } : {})
    });
  }
  return evidence;
}

function isSourceType(value: unknown): value is SourceType {
  return value === "conversation" || value === "commit" || value === "decision";
}
