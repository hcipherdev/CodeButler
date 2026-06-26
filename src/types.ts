export type SourceType = "conversation" | "commit" | "decision";
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
export type SyncSourceName = "git" | "codex" | "claude";
export type DoctorStatus = "ok" | "warning" | "error";
export type DoctorCheckCategory = "project" | "storage" | "sources" | "sync" | "summary" | "extractor" | "memory";
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
  confidence?: number | undefined;
  evidenceCount: number;
  resolvedEvidenceCount: number;
  unresolvedEvidenceCount: number;
  sourceTypes: string[];
  reasons: string[];
  lastVerifiedAt?: string | undefined;
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
  id: string;
  topic: string;
  decision: string;
  reason: string;
  status: string;
  evidence: EvidenceRef[];
  createdAt: string;
}

export interface ExtractedMemory {
  type: MemoryType;
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
}

export interface MemorySearchResult {
  kind: "candidate" | "promoted";
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  reason: string;
  confidence: number;
  evidence: EvidenceRef[];
  relatedFiles: string[];
  dedupeKey: string;
  qualityStatus: MemoryQualityStatus;
  qualityReasons: string[];
  lastVerifiedAt?: string | undefined;
  citations?: EvidenceCitation[] | undefined;
  trust?: TrustSummary | undefined;
}

export interface TemporaryMemory {
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

export interface ExtractorContext {
  conversations: ExtractorConversationInput[];
  commits: CommitRecord[];
}

export interface RejectedMemory {
  index: number;
  reason: string;
}

export interface ExtractorResult {
  memories: ExtractedMemory[];
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

export type LlmProviderName = "openai-compatible" | "anthropic-aws";

export interface ExtractorConfig {
  provider: LlmProviderName;
  baseUrl?: string | undefined;
  model: string;
  apiKeyEnv: string;
  workspaceIdEnv?: string | undefined;
  regionEnv?: string | undefined;
  maxTokens?: number | undefined;
}

export interface PromotionConfig {
  confidenceThreshold: number;
  requireCommitAndConversation: boolean;
  minSourceCategories: number;
}

export interface SyncConfig {
  autoSyncOnServerStart: boolean;
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
  maxDepth: number;
  maxSteps: number;
  maxBranching: number;
  topKPerSearch: number;
  evidenceThreshold: number;
  returnTrace: boolean;
}

export interface ProjectConfig {
  configPath: string;
  sources: {
    git: GitSourceConfig;
    codex: CodexLogSourceConfig;
    claude: ConversationLogSourceConfig;
  };
  extractor: ExtractorConfig;
  promotion: PromotionConfig;
  sync: SyncConfig;
  deterministic: DeterministicConfig;
  investigator: InvestigatorConfig;
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
