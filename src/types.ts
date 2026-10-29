import type { MemoryReviewAction, OperationActor } from "./operations/types.js";

export type SourceType = "conversation" | "commit" | "decision";
export type {
  AutomaticPromotionDecisionKind,
  BeginOperationInput,
  BranchTriageAction,
  CreateSourceTombstoneInput,
  FinishOperationInput,
  LayerRetentionDecisionKind,
  MemoryReviewAction,
  ListOperationsInput,
  OperationActor,
  OperationLogEntry,
  OperationMetadata,
  OperationMetadataByType,
  OperationStatus,
  OperationType,
  SourceTombstone
} from "./operations/types.js";
export type MemoryType = "decision" | "bug_fix" | "constraint" | "rejected_approach";
export type TemporaryMemoryKind =
  | "task_state"
  | "open_question"
  | "working_hypothesis"
  | "recent_test"
  | "file_context"
  | "user_instruction";
export type MemoryPromotionState = "candidate" | "promoted";
export type MemoryQualityStatus = "active" | "needs_review" | "quarantined";
export type MemoryTrustDisplayStatus = "human_verified" | "ai_validated" | "evidence_backed" | "needs_review" | "quarantined";
export type MemoryConfidenceBasis =
  | "manual"
  | "explicit_directive"
  | "decision_file"
  | "test_expectation"
  | "model_extraction"
  | "legacy_config_key"
  | "legacy_docs_heading"
  | "unknown";
export type MemoryLifecycleStatus = "current" | "superseded" | "retracted";
export type MemoryReconciliationVerdict = "current" | "changed" | "obsolete" | "low_value" | "uncertain";
export type MemoryRelationType = "supersedes" | "potentially_contradicts";
export type SyncSourceName = "git" | "codex" | "claude";
export type DoctorStatus = "ok" | "warning" | "error";
export type DoctorCheckCategory = "project" | "storage" | "sources" | "sync" | "summary" | "extractor" | "retrieval" | "memory" | "maintenance";
export type InvestigationMode = "native-rlm" | "heuristic-fallback";
export type InvestigationStatus = "complete" | "partial" | "failed";
export type InvestigationStepStatus = "completed" | "failed" | "skipped";
export type InvestigationTerminationReason =
  | "finalize_answer"
  | "evidence_threshold"
  | "max_steps"
  | "max_depth"
  | "no_new_evidence"
  | "invalid_action"
  | "heuristic_fallback";
export type InvestigationEntityType =
  | "source"
  | "chunk"
  | "commit"
  | "decision"
  | "memory"
  | "candidate"
  | "temporary_memory"
  | "file";

export interface EvidenceRef {
  sourceType: SourceType;
  sourceId: string;
  locator?: string | undefined;
}

export type EvidenceCitationKind = SourceType | "file" | "project_summary" | "missing";

export interface EvidenceCitation {
  kind: EvidenceCitationKind;
  sourceId: string;
  label: string;
  summary: string;
  resolved: boolean;
  locator?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TrustSummary {
  status: MemoryQualityStatus;
  displayStatus?: MemoryTrustDisplayStatus | undefined;
  confidenceBasis?: MemoryConfidenceBasis | undefined;
  confidence?: number | undefined;
  evidenceCount: number;
  resolvedEvidenceCount: number;
  unresolvedEvidenceCount: number;
  sourceTypes: string[];
  reasons: string[];
  lastVerifiedAt?: string | undefined;
}

export interface MemoryReviewSummary {
  id: string;
  action: MemoryReviewAction;
  reason: string;
  reviewedAt: string;
  actor: OperationActor;
  resolvedReasons: string[];
  current: boolean;
  replacementMemoryId?: string | undefined;
  replacementCategory?: "candidate" | "promoted" | undefined;
  verdict?: MemoryReconciliationVerdict | undefined;
  policyVersion?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  confidence?: number | undefined;
  citationIds?: string[] | undefined;
  reconciliationRunId?: string | undefined;
  reconciliationItemId?: string | undefined;
}

export interface MemoryReviewProvenance {
  verdict: MemoryReconciliationVerdict;
  policyVersion: string;
  confidence: number;
  citationIds: string[];
  reconciliationRunId: string;
  reconciliationItemId: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export interface MemorySource {
  id?: string;
  type: SourceType;
  title: string;
  origin: string;
  rawContent: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryChunk {
  id?: string;
  sourceId?: string;
  sourceType?: SourceType;
  chunkIndex?: number;
  text: string;
  metadata?: Record<string, unknown>;
  /** Extractor input only: an already-extracted message sent so the new ones read in context. */
  contextOnly?: boolean | undefined;
}

export interface SearchResult {
  chunkId: string;
  sourceId: string;
  sourceType: SourceType;
  title: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
  evidence: EvidenceRef;
  citations?: EvidenceCitation[] | undefined;
  trust?: TrustSummary | undefined;
  ranking?: RankingMetadata | undefined;
}

export interface RankingMetadata {
  lexicalRank?: number | undefined;
  semanticRank?: number | undefined;
  fusedScore: number;
}

export interface CommitRecord {
  hash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  message: string;
  changedFiles: string[];
  diffSummary: string;
}

export interface DecisionRecord {
  scope?: MemoryScope;
  applicability?: Applicability;
  id: string;
  topic: string;
  decision: string;
  reason: string;
  status: string;
  evidence: EvidenceRef[];
  createdAt: string;
}

export type MemoryScope = { kind: "project" } | { kind: "unspecified" } | {
  kind: "conditional";
  platforms?: string[];
  architectures?: string[];
  shells?: string[];
  condition?: string;
};

/** Where a memory syncs, not where its advice applies. Orthogonal to MemoryScope. */
export type MemoryLayer = string;
export interface ParsedMemoryLayer {
  kind: "core" | "device" | "branch";
  deviceId?: string;
  branch?: string;
}
export type MemoryLayerFilter = "core" | "device" | "branch" | "all";
/**
 * Orthogonal to the layer filter, the way scope is orthogonal to layer: `layer` says
 * which kind of layer, `owner` says whose. Peer rows are another device's read-only
 * partition, so they are excluded unless asked for by name.
 */
export type MemoryLayerOwner = "self" | "peer" | "any";
export interface TargetEnvironment { platform?: string; arch?: string; shell?: string; }
export interface Applicability {
  status: "project_wide" | "matches" | "mismatch" | "needs_verification";
  environment: TargetEnvironment;
  source: "explicit" | "butler_host_default";
  reasons: string[];
}

/** Where Butler generated a memory, not where its advice applies. */
export interface MemoryOrigin {
  deviceId: string;
  platform: string;
  arch: string;
  generatedAt: string;
  method: "deterministic" | "llm" | "manual";
  channel: "sync" | "cli" | "mcp" | "desktop";
  client?: { name: string; version?: string };
  generator?: { provider?: string; model?: string };
}

export interface MemoryStatementFields {
  choice?: string | undefined;
  rationale?: string | undefined;
  alternatives?: string | undefined;
  requirement?: string | undefined;
  appliesWhen?: string | undefined;
  symptom?: string | undefined;
  cause?: string | undefined;
  fix?: string | undefined;
  tried?: string | undefined;
  droppedBecause?: string | undefined;
  revisitIf?: string | undefined;
}

export interface MemoryStatement {
  version: 1;
  text: string;
  fields: MemoryStatementFields;
  origin: "human" | "submitted" | "deterministic" | "extracted" | "ai_wording_accepted";
}

export interface MemoryPresentation {
  headline: string;
  text: string;
  slots: Array<{ label: string; value: string }>;
  missing: string[];
  sharing: string;
  applies: string;
  state: string;
  verified: boolean;
  claim: "meaningful" | "missing_claim";
  derived: boolean;
}

export interface ExtractedMemory {
  scope?: MemoryScope;
  layer?: MemoryLayer;
  applicability?: Applicability;
  origin?: MemoryOrigin | null;
  type: MemoryType;
  statement?: MemoryStatement | undefined;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  evidence: EvidenceRef[];
  relatedFiles: string[];
  dedupeKey: string;
}

export interface MemoryCandidate extends ExtractedMemory {
  id: string;
  promotionState: MemoryPromotionState;
  promotedMemoryId?: string | undefined;
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface DurableMemory extends ExtractedMemory {
  id: string;
  createdAt: string;
  promotedAt: string;
  source: "auto" | "manual";
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
  subjectKey: string;
  lifecycleStatus: MemoryLifecycleStatus;
  validFrom: string;
  validUntil?: string | undefined;
  statusReason?: string | undefined;
  statusChangedAt: string;
  lifecycleGeneration: string;
}

export interface MemoryRelation {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: MemoryRelationType;
  createdAt: string;
  reason?: string | undefined;
}

export interface MemorySearchResult {
  scope?: MemoryScope;
  layer?: MemoryLayer;
  applicability?: Applicability;
  origin?: MemoryOrigin | null;
  kind: "candidate" | "promoted";
  id: string;
  type: MemoryType;
  statement?: MemoryStatement | undefined;
  presentation?: MemoryPresentation;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  confidenceBasis?: MemoryConfidenceBasis | undefined;
  evidence: EvidenceRef[];
  relatedFiles: string[];
  dedupeKey: string;
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
  reviewToken?: string | undefined;
  review?: MemoryReviewSummary | undefined;
  subjectKey?: string | undefined;
  lifecycleStatus?: MemoryLifecycleStatus | undefined;
  validFrom?: string | undefined;
  validUntil?: string | undefined;
  statusReason?: string | undefined;
  statusChangedAt?: string | undefined;
  citations?: EvidenceCitation[] | undefined;
  displayStatus?: MemoryTrustDisplayStatus | undefined;
  trust?: TrustSummary | undefined;
  ranking?: RankingMetadata | undefined;
  /** Present only for multi-term queries in terms mode: how many query terms this memory contains. */
  match?: { terms: number; matched: number } | undefined;
}

export interface TemporaryMemory {
  scope?: MemoryScope;
  layer?: MemoryLayer;
  applicability?: Applicability;
  origin?: MemoryOrigin | null;
  id: string;
  projectId: string;
  threadId?: string;
  sessionId?: string;
  sourceAdapter?: string;
  kind: TemporaryMemoryKind;
  title: string;
  summary: string;
  details: string;
  relatedFiles: string[];
  evidence: EvidenceRef[];
  confidence: number;
  citations?: EvidenceCitation[] | undefined;
  trust?: TrustSummary | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TemporaryMemorySearchResult extends TemporaryMemory {
  score: number;
  rank: number;
}

export interface TemporaryMemoryUpsertInput {
  scope?: MemoryScope;
  layer?: MemoryLayer;
  applicability?: Applicability;
  origin?: MemoryOrigin | null;
  id?: string;
  projectId?: string;
  threadId?: string;
  sessionId?: string;
  sourceAdapter?: string;
  kind: TemporaryMemoryKind;
  title: string;
  summary: string;
  details?: string;
  relatedFiles?: string[];
  evidence?: EvidenceRef[];
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
}

export interface SyncCursor {
  source: SyncSourceName;
  cursorKey: string;
  cursorValue: string;
  updatedAt: string;
}

export interface SyncStatus {
  source: SyncSourceName;
  enabled: boolean;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceFailure {
  id: string;
  adapter: SyncSourceName;
  path: string;
  errorCode: string;
  message: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  attempts: number;
  resolvedAt?: string | undefined;
}

export interface DoctorCheck {
  id: string;
  category: DoctorCheckCategory;
  status: DoctorStatus;
  title: string;
  detail: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface DoctorNextAction {
  priority: "high" | "medium" | "low";
  command: string;
  reason: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  generatedAt: string;
  projectRoot: string;
  checks: DoctorCheck[];
  nextActions: DoctorNextAction[];
}

export interface ExtractorConversationInput {
  sourceId: string;
  title: string;
  rawContent: string;
  chunks?: MemoryChunk[] | undefined;
  metadata?: Record<string, unknown>;
}

/** An existing memory offered to the extractor so it can say a new one repeats or replaces it. */
export interface ExistingMemoryInput {
  /** Short handle such as "E1", valid within one extraction batch. */
  ref: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: "durable" | "candidate";
  /** When the newest evidence behind it was observed, or when it was recorded. */
  recordedAt: string;
}

export interface ExtractorContext {
  conversations: ExtractorConversationInput[];
  commits: CommitRecord[];
  existingMemories?: ExistingMemoryInput[] | undefined;
}

/** An extracted memory plus what the model said about existing memories; never stored as such. */
export interface ExtractorMemory extends ExtractedMemory {
  /** Ref of an existing memory of the same type that states the same fact. */
  sameAs?: string | undefined;
  /** An existing memory this one shows no longer holds. */
  invalidates?: { ref: string; confidence: number; why: string } | undefined;
}

export interface RejectedMemory {
  /** Which field failed, when the reason alone does not say. */
  detail?: string | undefined;
  index: number;
  reason: string;
}

export interface ExtractorResult {
  memories: ExtractorMemory[];
  rejected: RejectedMemory[];
}

export interface ExtractorProvider {
  extract(context: ExtractorContext): Promise<ExtractorResult>;
}

export interface GitSourceConfig {
  enabled: boolean;
  repoPath: string;
  hookInstall: boolean;
  maxCommits: number;
  maxDiffChars: number;
}

export interface ConversationLogSourceConfig {
  enabled: boolean;
  roots: string[];
  projectOnly: boolean;
}

export interface CodexLogSourceConfig extends ConversationLogSourceConfig {
  includeDefaultRoots: boolean;
}

export type LlmProviderName = "openai-compatible" | "anthropic-aws" | "anthropic";

/** A named provider account in the global `ai.connections` settings. */
export type AiConnectionKind = "openrouter" | "anthropic" | "anthropic-aws" | "openai" | "gemini" | "qwen" | "ollama" | "lmstudio" | "openai-compatible";
/** Every purpose Code Butler calls a model for; each resolves to one connection and model. */
export type AiJob = "extraction" | "review" | "wording" | "summary" | "investigator" | "rules" | "consolidation";
export const AI_JOBS: readonly AiJob[] = ["extraction", "review", "wording", "summary", "investigator", "rules", "consolidation"];

export interface AiConnectionConfig {
  kind: AiConnectionKind;
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  workspaceIdEnv?: string | undefined;
  regionEnv?: string | undefined;
  /** Not secret, so stored in config; the matching *Env variable wins when set. */
  workspaceId?: string | undefined;
  region?: string | undefined;
  /** Set when a key was saved to the OS keychain; changing it invalidates cached keys. */
  keyUpdatedAt?: string | undefined;
  /** Set when the app wrote this connection's key to the global .env under apiKeyEnv. */
  keySavedToEnv?: true | undefined;
  /** OpenRouter only: refuse upstream providers that retain or train on prompts. Default deny. */
  dataCollection?: "allow" | "deny" | undefined;
}

export interface AiModelChoice { connection: string; model: string; maxTokens?: number | undefined }
export type AiJobChoice = AiModelChoice | { tier: "fast" | "smart" };

export interface AiSettings {
  connections?: Record<string, AiConnectionConfig> | undefined;
  tiers?: { fast?: AiModelChoice | undefined; smart?: AiModelChoice | undefined } | undefined;
  jobs?: Partial<Record<AiJob, AiJobChoice>> | undefined;
  budgets?: { backgroundDailyTokens?: number | null | undefined } | undefined;
}

export interface ExtractorConfig {
  provider: LlmProviderName;
  baseUrl?: string | undefined;
  model: string;
  apiKeyEnv: string;
  workspaceIdEnv?: string | undefined;
  regionEnv?: string | undefined;
  maxTokens?: number | undefined;
  /** Set when the model comes from an `ai` connection rather than legacy profiles. */
  connectionId?: string | undefined;
  connectionLabel?: string | undefined;
  connectionKind?: AiConnectionKind | undefined;
  keyUpdatedAt?: string | undefined;
  workspaceId?: string | undefined;
  region?: string | undefined;
  dataCollection?: "allow" | "deny" | undefined;
  /** The built-in default would send project content to a remote model the person never chose. */
  requiresConsent?: boolean | undefined;
}

/** One job's model after tiers, job overrides and project overrides are applied. */
export interface ResolvedModel extends ExtractorConfig {
  job: AiJob;
  source: "ai" | "legacy" | "project-override";
  /** False only when the legacy investigator is switched off. */
  enabled?: boolean | undefined;
}

export interface ExtractorConfigInput extends Partial<ExtractorConfig> {
  profile?: string | undefined;
}

export interface AutomaticPromotionConfig {
  enabled: boolean;
  mode: "conservative";
  minScore: number;
  mergedBranches: boolean;
  deviceMemories: boolean;
  /** Promote corroborated candidates already in the core layer (main-branch findings). */
  coreCandidates: boolean;
  /** Confidence bar for a core candidate whose only corroboration is an AI "current" verdict. */
  singleSourceMinConfidence: number;
}

export interface PromotionConfig {
  confidenceThreshold: number;
  requireCommitAndConversation: boolean;
  minSourceCategories: number;
  automatic: AutomaticPromotionConfig;
}

export interface SyncConfig {
  autoSyncOnServerStart: boolean;
  /**
   * Which of this device's own non-core layers are published for peers to read.
   * `durable` shares device- and branch-layer memories; `all` adds temporary session
   * state; `none` keeps every non-core row local, which was the behaviour before
   * partitions existed.
   */
  shareLocalLayers: "durable" | "all" | "none";
  /**
   * What happens when local and cloud memory both changed since the last sync. `merge`
   * runs the three-way merge automatically and stops only when it would delete a large
   * share of this device's memories; `ask` leaves every such case for a person.
   */
  conflictPolicy: "merge" | "ask";
}

export type RetrievalMode = "fts" | "hybrid";

export interface RetrievalConfig {
  mode: RetrievalMode;
  rrfK: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | undefined;
  batchSize: number;
}

export interface PrivacyConfig {
  allowRemoteEmbeddings: boolean;
  /** Lets the built-in default model run on a key found only in the shell environment. */
  allowRemoteModels?: boolean;
  redactionPatterns?: RedactionPatternConfig[];
}

export interface RedactionPatternConfig {
  name: string;
  pattern: string;
  kind: "literal" | "regex";
  flags?: string;
}

export interface SourceRetentionPolicy {
  maxAgeDays: number | null;
}

export interface SourceRetentionOverride extends SourceRetentionPolicy {
  sourceId: string;
}

/**
 * Retention for durable non-core memory. Temporary memories are already bounded by
 * their TTL, and `core` is never touched: this only ages out this device's own
 * device- and branch-layer durable memory.
 */
export interface LayerRetentionConfig {
  enabled: boolean;
  /** Quiet period a memory must sit untouched before any archival applies. */
  graceDays: number;
  branch: {
    /** Applied once the branch no longer exists locally. */
    onDeleted: "archive" | "keep";
    /** Merged branches are left to promotion and triage. */
    onMerged: "archive" | "keep";
    maxIdleDays: number | null;
  };
  device: {
    maxIdleDays: number | null;
  };
}

export interface ArtifactRetentionConfig {
  logs: {
    maxBytes: number;
    maxFiles: number;
  };
  projectSummaryBackups: {
    maxFiles: number;
  };
  recoveryBackups: {
    maxFiles: number;
    minAgeDays: number;
  };
  cloudHandles: {
    reapStale: boolean;
  };
}

export interface RetentionConfig {
  migrationBackups: number;
  sources: {
    git: SourceRetentionPolicy;
    codex: SourceRetentionPolicy;
    claude: SourceRetentionPolicy;
    manual: SourceRetentionPolicy;
  };
  overrides: SourceRetentionOverride[];
  layers: LayerRetentionConfig;
  artifacts: ArtifactRetentionConfig;
}

export type EmbeddingOwnerKind = "chunk" | "memory";
export type EmbeddingJobState = "pending" | "complete" | "failed";

export interface EmbeddingOwner {
  ownerKind: EmbeddingOwnerKind;
  ownerId: string;
  text: string;
  contentHash: string;
  ownerVersion: string;
}

export interface EmbeddingJob {
  ownerKind: EmbeddingOwnerKind;
  ownerId: string;
  contentHash: string;
  ownerVersion: string;
  providerKey: string;
  endpointHash: string;
  model: string;
  indexGeneration: string;
  state: EmbeddingJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  providerFingerprint?: string | undefined;
  targetFingerprint?: string | undefined;
  lastError?: string | undefined;
  completedAt?: string | undefined;
}

export interface EmbeddingVector {
  ownerKind: EmbeddingOwnerKind;
  ownerId: string;
  contentHash: string;
  ownerVersion: string;
  providerKey: string;
  endpointHash: string;
  model: string;
  providerFingerprint: string;
  dimension: number;
  vectorBlob: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingBatchResult {
  vectors: number[][];
  dimension: number;
  providerFingerprint: string;
}

export interface EmbeddingProvider {
  endpointHash: string;
  providerKey: string;
  isRemote: boolean;
  embed(inputs: string[]): Promise<EmbeddingBatchResult>;
}

export interface DeterministicConfig {
  enabled: boolean;
  promoteStrongSignals: boolean;
  triggers: {
    conversationDirectives: boolean;
    gitChangedFiles: boolean;
    decisionFiles: boolean;
    testExpectations: boolean;
    packageAndConfigFacts: boolean;
    docsFacts: boolean;
  };
}

export interface InvestigatorConfig {
  enabled: boolean;
  mode: "native-rlm";
  provider: LlmProviderName;
  baseUrl?: string | undefined;
  model: string;
  apiKeyEnv: string;
  workspaceIdEnv?: string | undefined;
  regionEnv?: string | undefined;
  maxTokens?: number | undefined;
  connectionId?: string | undefined;
  connectionLabel?: string | undefined;
  connectionKind?: AiConnectionKind | undefined;
  keyUpdatedAt?: string | undefined;
  workspaceId?: string | undefined;
  region?: string | undefined;
  dataCollection?: "allow" | "deny" | undefined;
  requiresConsent?: boolean | undefined;
  maxDepth: number;
  maxSteps: number;
  maxBranching: number;
  topKPerSearch: number;
  evidenceThreshold: number;
  returnTrace: boolean;
}

export interface InvestigatorConfigInput extends Partial<InvestigatorConfig> {
  profile?: string | undefined;
}

/** How conversation logs are fed to the extractor; see docs/operations.md#memory-extraction. */
export interface ExtractionConfig {
  /** The watcher waits this long after a session log last changed before extracting it. */
  conversationQuietMinutes: number;
  /** A session that never goes quiet is still extracted this long after its last extraction. */
  conversationMaxWaitMinutes: number;
  /** A session with this many unextracted messages is extracted without waiting. */
  maxDeltaChunks: number;
  /** Already-extracted messages sent before the new ones, read only for context. */
  overlapChunks: number;
  /** Existing memories offered to the extractor so it can reuse or invalidate them. */
  relatedMemories: number;
}

/** The daily AI re-check of flagged memories; see docs/operations.md#automatic-review. */
export interface AutomaticReviewConfig {
  enabled: boolean;
  /** Memories sent to the investigator model per day, one request each. */
  dailyItems: number;
  /** Estimated input plus output tokens one daily run may spend. */
  tokenBudget: number;
  /** Verdicts applied without asking; corrections always wait for a person. */
  applyVerdicts: Array<"current" | "obsolete" | "low_value">;
}

export interface ProjectConfig {
  globalRules?: { enabled: boolean; exclude: string[] };
  configPath: string;
  sources: {
    git: GitSourceConfig;
    codex: CodexLogSourceConfig;
    claude: ConversationLogSourceConfig;
  };
  extractor: ExtractorConfig;
  promotion: PromotionConfig;
  sync: SyncConfig;
  retrieval: RetrievalConfig;
  embeddings: EmbeddingConfig;
  privacy: PrivacyConfig;
  retention?: RetentionConfig;
  deterministic: DeterministicConfig;
  investigator: InvestigatorConfig;
  /** Optional so hand-built configs keep working; read it through extractionPolicy(). */
  extraction?: ExtractionConfig;
  /** Optional for the same reason; read it through automaticReviewPolicy(). */
  review?: { automatic: AutomaticReviewConfig };
  /** Per-job models; optional so hand-built configs keep working. Read it through jobModel(). */
  models?: Record<AiJob, ResolvedModel>;
  /** Daily token cap for background AI work; null means no cap. */
  aiBudget?: { backgroundDailyTokens: number | null };
}

export interface InvestigationEntityRef {
  entityType: InvestigationEntityType;
  entityId: string;
}

export interface InvestigationNode {
  id: string;
  question: string;
  depth: number;
  targetEntity?: InvestigationEntityRef | undefined;
  parentNodeId?: string | undefined;
}

export interface InvestigationBudget {
  maxDepth: number;
  maxSteps: number;
  maxBranching: number;
  topKPerSearch: number;
  evidenceThreshold: number;
}

export type InvestigationAction =
  | {
      type: "search_temporary_memory";
      query: string;
      threadId?: string | undefined;
      sessionId?: string | undefined;
      limit?: number | undefined;
    }
  | {
      type: "search_memories";
      query: string;
      limit?: number | undefined;
      status?: "promoted" | "candidate" | undefined;
    }
  | {
      type: "search_raw_sources";
      query: string;
      limit?: number | undefined;
      sourceTypes?: SourceType[] | undefined;
    }
  | {
      type: "find_related_commits";
      query?: string | undefined;
      filePath?: string | undefined;
      limit?: number | undefined;
    }
  | {
      type: "read_source";
      sourceId: string;
    }
  | {
      type: "read_conversation_window";
      sourceId: string;
      anchorChunkId?: string | undefined;
      chunkIndex?: number | undefined;
      before?: number | undefined;
      after?: number | undefined;
    }
  | {
      type: "read_commit";
      hash: string;
    }
  | {
      type: "follow_evidence_refs";
      evidence: EvidenceRef[];
      limit?: number | undefined;
    }
  | {
      type: "expand_entity_links";
      entity: InvestigationEntityRef;
      limit?: number | undefined;
    }
  | {
      type: "spawn_subinvestigation";
      question: string;
      targetEntity?: InvestigationEntityRef | undefined;
    }
  | {
      type: "finalize_answer";
    };

export interface InvestigationObservation {
  summary: string;
  evidence: EvidenceRef[];
  entityLinks?: InvestigationEntityLink[] | undefined;
  searchResults?: SearchResult[] | undefined;
  temporaryMemories?: TemporaryMemorySearchResult[] | undefined;
  memoryResults?: MemorySearchResult[] | undefined;
  commits?: CommitRecord[] | undefined;
  sources?: MemorySource[] | undefined;
  chunks?: MemoryChunk[] | undefined;
  source?: MemorySource | undefined;
  commit?: CommitRecord | undefined;
}

export interface InvestigationStep {
  stepId: string;
  depth: number;
  parentStepId?: string | undefined;
  action: InvestigationAction;
  actionInput: Record<string, unknown>;
  observationSummary: string;
  newEvidence: EvidenceRef[];
  spawnedChildren: string[];
  plannerRationale: string;
  status: InvestigationStepStatus;
}

export interface InvestigationTrace {
  steps: InvestigationStep[];
}

export interface InvestigationPlannerState {
  mode: InvestigationMode;
  question: string;
  rootQuestion: string;
  depth: number;
  node: InvestigationNode;
  budget: InvestigationBudget;
  trace: InvestigationTrace;
  evidence: EvidenceRef[];
  visitedEntities: string[];
  relatedCommits: CommitRecord[];
  relatedDecisions: DecisionRecord[];
  temporaryMemories?: TemporaryMemorySearchResult[];
  relatedMemories: DurableMemory[];
  candidateMemories: MemoryCandidate[];
  searchResults: SearchResult[];
}

export interface InvestigationPlanDecision {
  action: InvestigationAction;
  rationale: string;
}

export interface InvestigationSynthesis {
  answer: string;
  evidenceScore: number;
}

export interface InvestigatorProvider {
  planNextAction(
    state: InvestigationPlannerState,
    options?: { retryReason?: string | undefined } | undefined
  ): Promise<InvestigationPlanDecision>;
  synthesizeAnswer(state: InvestigationPlannerState): Promise<InvestigationSynthesis>;
}

export interface InvestigationEntityLink {
  sourceType: string;
  sourceId: string;
  relation: string;
  targetType: string;
  targetId: string;
  locator?: string | undefined;
  direction: "outgoing" | "incoming";
}

export interface InvestigationRunOptions {
  config?: ProjectConfig;
  investigatorProvider?: InvestigatorProvider;
  /** Wraps each model call, e.g. so the MCP server can release the project lock while it waits. */
  aroundModelCall?: <T>(call: () => Promise<T>) => Promise<T>;
}

export interface InvestigationResult {
  answer: string;
  evidence: EvidenceRef[];
  citations: EvidenceCitation[];
  trust: TrustSummary;
  searchResults: SearchResult[];
  relatedCommits: CommitRecord[];
  relatedDecisions: DecisionRecord[];
  temporaryMemories?: TemporaryMemorySearchResult[];
  relatedMemories?: DurableMemory[];
  candidateMemories?: MemoryCandidate[];
  mode: InvestigationMode;
  status: InvestigationStatus;
  trace: InvestigationTrace;
  terminationReason: InvestigationTerminationReason;
  evidenceScore: number;
  visitedEntities: string[];
}
