export const PRIVACY_EXPORT_FORMAT = "code-butler-privacy-export";
export const PRIVACY_EXPORT_VERSION = 1;

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
  "sources",
  "chunks",
  "commits",
  "decisions",
  "relations",
  "sync_sources",
  "sync_cursors",
  "memory_candidates",
  "memories",
  "memory_links",
  "temporary_memories",
  "temporary_memory_links",
  "memory_relations",
  "source_failures",
  "source_tombstones",
  "private_identity_mappings",
  "operation_log"
] as const;
