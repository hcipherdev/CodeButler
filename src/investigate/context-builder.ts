import type {
  CommitRecord,
  DecisionRecord,
  DurableMemory,
  EvidenceRef,
  InvestigationAction,
  InvestigationBudget,
  InvestigationMode,
  InvestigationNode,
  InvestigationPlannerState,
  InvestigationStep,
  InvestigationTerminationReason,
  MemoryCandidate,
  SearchResult,
  TemporaryMemorySearchResult
} from "../types.js";

export interface InvestigationAnchors {
  normalizedQuestion: string;
  filePath?: string;
  commitHash?: string;
  decisionLike: boolean;
}

export interface InvestigationRuntimeNode extends InvestigationNode {
  stepBudget: number;
  parentStepId?: string;
  spawnedChildren: number;
}

export interface SharedInvestigationContext {
  rootQuestion: string;
  mode: InvestigationMode;
  budget: InvestigationBudget;
  traceSteps: InvestigationStep[];
  evidence: Map<string, EvidenceRef>;
  searchResults: Map<string, SearchResult>;
  relatedCommits: Map<string, CommitRecord>;
  relatedDecisions: Map<string, DecisionRecord>;
  temporaryMemories: Map<string, TemporaryMemorySearchResult>;
  relatedMemories: Map<string, DurableMemory>;
  candidateMemories: Map<string, MemoryCandidate>;
  visitedEntities: Set<string>;
  visitedActionKeys: Set<string>;
  nextStepNumber: number;
  nextNodeNumber: number;
  totalSteps: number;
  plannerSteps: number;
  noNewEvidenceStreak: number;
  terminationReason?: InvestigationTerminationReason;
}

export interface InvestigationSeed {
  actions: Array<{ action: InvestigationAction; rationale: string }>;
  decisionLookup?: { topic?: string; limit: number };
}

export function deriveInvestigationAnchors(
  question: string,
  overrides: { filePath?: string } = {}
): InvestigationAnchors {
  const normalizedQuestion = question.trim();
  const filePath =
    overrides.filePath ??
    normalizedQuestion.match(/(?:[\w.-]+\/)+[\w.-]+/)?.[0];
  const commitHash = normalizedQuestion.match(/\b[0-9a-f]{7,40}\b/i)?.[0];
  const anchors: InvestigationAnchors = {
    normalizedQuestion,
    decisionLike: /\b(decision|decide|chose|choose|rejected|bug|fix|why|reason)\b/i.test(normalizedQuestion)
  };
  if (filePath) anchors.filePath = filePath;
  if (commitHash) anchors.commitHash = commitHash;
  return anchors;
}

export function createInvestigationContext(
  rootQuestion: string,
  anchors: InvestigationAnchors,
  budget: InvestigationBudget
): { shared: SharedInvestigationContext; rootNode: InvestigationRuntimeNode } {
  const shared: SharedInvestigationContext = {
    rootQuestion,
    mode: "native-rlm",
    budget,
    traceSteps: [],
    evidence: new Map(),
    searchResults: new Map(),
    relatedCommits: new Map(),
    relatedDecisions: new Map(),
    temporaryMemories: new Map(),
    relatedMemories: new Map(),
    candidateMemories: new Map(),
    visitedEntities: new Set(),
    visitedActionKeys: new Set(),
    nextStepNumber: 1,
    nextNodeNumber: 2,
    totalSteps: 0,
    plannerSteps: 0,
    noNewEvidenceStreak: 0
  };
  const rootNode: InvestigationRuntimeNode = {
    id: "node-1",
    question: anchors.normalizedQuestion,
    depth: 0,
    stepBudget: budget.maxSteps,
    spawnedChildren: 0
  };

  if (anchors.filePath) {
    rootNode.targetEntity = { entityType: "file", entityId: anchors.filePath };
    shared.visitedEntities.add(`file:${anchors.filePath}`);
  }
  if (anchors.commitHash) {
    shared.visitedEntities.add(`commit:${anchors.commitHash}`);
  }

  return { shared, rootNode };
}

export function buildInvestigationSeed(
  anchors: InvestigationAnchors,
  budget: InvestigationBudget
): InvestigationSeed {
  const searchQuery = [anchors.filePath, anchors.normalizedQuestion].filter(Boolean).join(" ").trim();
  const query = searchQuery || anchors.normalizedQuestion;
  const actions: InvestigationSeed["actions"] = [
    {
      action: {
        type: "search_temporary_memory",
        query,
        limit: budget.topKPerSearch
      },
      rationale: "Initial temporary working-context seed."
    },
    {
      action: {
        type: "search_memories",
        query,
        limit: budget.topKPerSearch
      },
      rationale: "Initial memory-layer seed."
    },
    {
      action: {
        type: "search_raw_sources",
        query,
        limit: budget.topKPerSearch
      },
      rationale: "Initial raw-source seed."
    }
  ];

  if (anchors.filePath) {
    actions.push({
      action: {
        type: "find_related_commits",
        filePath: anchors.filePath,
        limit: budget.topKPerSearch
      },
      rationale: "Initial file-to-commit seed."
    });
  } else if (anchors.commitHash) {
    actions.push({
      action: {
        type: "read_commit",
        hash: anchors.commitHash
      },
      rationale: "Initial commit anchor seed."
    });
  }

  const seed: InvestigationSeed = { actions };
  if (anchors.filePath) {
    seed.decisionLookup = { limit: budget.topKPerSearch };
  } else if (anchors.decisionLike) {
    seed.decisionLookup = {
      topic: anchors.normalizedQuestion,
      limit: budget.topKPerSearch
    };
  }
  return seed;
}

export function buildInvestigationPlannerContext(
  shared: SharedInvestigationContext,
  node: InvestigationRuntimeNode
): InvestigationPlannerState {
  const plannerNode: InvestigationNode = {
    id: node.id,
    question: node.question,
    depth: node.depth
  };
  if (node.targetEntity) plannerNode.targetEntity = node.targetEntity;
  if (node.parentNodeId) plannerNode.parentNodeId = node.parentNodeId;

  return {
    mode: shared.mode,
    question: node.question,
    rootQuestion: shared.rootQuestion,
    depth: node.depth,
    node: plannerNode,
    budget: shared.budget,
    trace: { steps: shared.traceSteps },
    evidence: [...shared.evidence.values()],
    visitedEntities: [...shared.visitedEntities],
    relatedCommits: [...shared.relatedCommits.values()],
    relatedDecisions: [...shared.relatedDecisions.values()],
    temporaryMemories: [...shared.temporaryMemories.values()],
    relatedMemories: [...shared.relatedMemories.values()],
    candidateMemories: [...shared.candidateMemories.values()],
    searchResults: [...shared.searchResults.values()]
  };
}
