import type { DatabaseSync } from "node:sqlite";

/** Stored content, including handbooks and history, must survive first linking. */
export function hasStoredProjectContent(database: DatabaseSync): boolean {
  const exists = (table: string) => !!database.prepare("select 1 from sqlite_master where type='table' and name=?").get(table);
  for (const table of ["sources", "chunks", "commits", "decisions", "memories", "memory_candidates", "temporary_memories", "relations", "memory_relations", "memory_links", "temporary_memory_links", "source_tombstones", "peer_partitions", "promotion_decisions", "memory_topics", "memory_topic_links", "memory_review_resolutions", "memory_review_resolution_compensations"]) {
    if (exists(table) && database.prepare(`select 1 from ${table} limit 1`).get()) return true;
  }
  // Migration 24 seeds one coverage boundary even in a newly initialized store.
  // Only that empty system event is scaffolding; authored history is content.
  return exists("memory_events") && !!database.prepare(`select 1 from memory_events where
    kind <> 'coverage' or memory_id <> '' or category <> 'promoted' or layer <> 'core'
    or actor <> 'system' or reason <> '' or related_memory_id is not null
    or related_category is not null or related_layer is not null
    or from_value is not null or to_value is not null limit 1`).get();
}
