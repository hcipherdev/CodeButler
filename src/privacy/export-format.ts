export const PRIVACY_EXPORT_FORMAT = "code-butler-privacy-export";
export const PRIVACY_EXPORT_VERSION = 2;

export interface PrivacyExportDocument {
  format: typeof PRIVACY_EXPORT_FORMAT;
  version: typeof PRIVACY_EXPORT_VERSION;
  exportedAt: string;
  redacted: boolean;
  embeddingProviders?: Array<{
    providerKey: string;
    endpointHash: string;
    model: string;
  }>;
  tables: Record<string, Array<Record<string, unknown>>>;
}

export const PRIVACY_EXPORT_TABLES = [
  "memory_events", "memory_topics", "memory_topic_links",
  "sources",
  "chunks",
  "commits",
  "decisions",
  "relations",
  "sync_sources",
  "sync_cursors",
  "extraction_jobs",
  "extraction_status",
  "memory_candidates",
  "memories",
  "memory_links",
  "temporary_memories",
  "temporary_memory_links",
  "memory_relations",
  "memory_review_resolutions",
  "memory_review_resolution_compensations",
  "branch_triage_reviews",
  "promotion_decisions",
  "layer_retention_decisions",
  "peer_partitions",
  "source_failures",
  "source_tombstones",
  "private_identity_mappings",
  "operation_log"
] as const;
