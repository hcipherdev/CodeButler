import { findDecisions } from "../decisions/store.js";
import type { MemoryStore } from "../storage/store.js";
import { investigationActionSchema } from "./actions.js";
import { createAnthropicAwsInvestigator } from "./anthropic-aws.js";
import { createOpenAICompatibleInvestigator } from "./openai.js";
import type {
  CommitRecord,
  DecisionRecord,
  DurableMemory,
  EvidenceRef,
  InvestigationAction,
  InvestigationBudget,
  InvestigationEntityLink,
  InvestigationEntityRef,
  InvestigationMode,
  InvestigationNode,
  InvestigationObservation,
  InvestigationResult,
  InvestigationRunOptions,
  InvestigationStep,
  InvestigationTerminationReason,
  InvestigationTrace,
  InvestigatorConfig,
  InvestigatorProvider,
  MemoryCandidate,
  MemorySearchResult,
  MemorySource,
  SearchResult,
  TemporaryMemorySearchResult
} from "../types.js";

interface InvestigationAnchors {
  normalizedQuestion: string;
  filePath?: string;
  commitHash?: string;
  decisionLike: boolean;
}

interface RuntimeNode extends InvestigationNode {
  stepBudget: number;
  parentStepId?: string;
  spawnedChildren: number;
}

interface ExecutedObservation extends InvestigationObservation {
  temporaryMemories?: TemporaryMemorySearchResult[];
  relatedMemories?: DurableMemory[];
  candidateMemories?: MemoryCandidate[];
  relatedDecisions?: DecisionRecord[];
  visitedEntities?: InvestigationEntityRef[];
}

interface SharedInvestigationState {
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

interface InvestigationRuntime {
  store: MemoryStore;
  provider: InvestigatorProvider;
  config: InvestigatorConfig;
  shared: SharedInvestigationState;
}

export async function explainCodeChange(
  store: MemoryStore,
  input: { filePath: string; lineNumber?: number; question?: string },
  options: InvestigationRunOptions = {}
): Promise<InvestigationResult> {
  const question = input.question?.trim() || `Why did we modify ${input.filePath}?`;
  const anchors = deriveAnchors(question, { filePath: input.filePath });
  const provider = resolveInvestigatorProvider(options);
  if (!options.config?.investigator.enabled || !provider) {
    return buildHeuristicFallback(store, {
      question,
      filePath: input.filePath,
      limit: 10
    });
  }

  return runNativeInvestigation(store, question, anchors, provider, options.config);
}

export async function investigateProjectHistory(
  store: MemoryStore,
  input: { question: string; limit?: number },
  options: InvestigationRunOptions = {}
): Promise<InvestigationResult> {
  const anchors = deriveAnchors(input.question);
  const provider = resolveInvestigatorProvider(options);
  if (!options.config?.investigator.enabled || !provider) {
    const fallbackInput: { question: string; filePath?: string; limit: number } = {
      question: input.question,
      limit: input.limit ?? 10
    };
    if (anchors.filePath) fallbackInput.filePath = anchors.filePath;
    return buildHeuristicFallback(store, fallbackInput);
  }

  return runNativeInvestigation(store, input.question, anchors, provider, options.config);
}

async function runNativeInvestigation(
  store: MemoryStore,
  question: string,
  anchors: InvestigationAnchors,
  provider: InvestigatorProvider,
  config: NonNullable<InvestigationRunOptions["config"]>
): Promise<InvestigationResult> {
  const budget = budgetFromConfig(config.investigator);
  const shared = createSharedState(question, budget);
  const runtime: InvestigationRuntime = {
    store,
    provider,
    config: config.investigator,
    shared
  };

  const rootNode: RuntimeNode = {
    id: createNodeId(shared),
    question: anchors.normalizedQuestion,
    depth: 0,
    stepBudget: budget.maxSteps,
    spawnedChildren: 0
  };
  if (anchors.filePath) rootNode.targetEntity = { entityType: "file", entityId: anchors.filePath };
  markVisitedEntity(shared, { entityType: "file", entityId: anchors.filePath ?? "" }, Boolean(anchors.filePath));
  markVisitedEntity(shared, { entityType: "commit", entityId: anchors.commitHash ?? "" }, Boolean(anchors.commitHash));

  await seedRootState(runtime, rootNode, anchors);
  if (shared.terminationReason === undefined) {
    await runNode(runtime, rootNode);
  }

  const plannerState = buildPlannerState(runtime.shared, rootNode);
  const synthesis = await synthesizeFinalAnswer(runtime, plannerState, anchors);
  return finalizeResult(store, question, anchors.filePath, runtime.shared, synthesis.answer, synthesis.evidenceScore);
}

async function seedRootState(
  runtime: InvestigationRuntime,
  node: RuntimeNode,
  anchors: InvestigationAnchors
): Promise<void> {
  const searchQuery = [anchors.filePath, anchors.normalizedQuestion].filter(Boolean).join(" ").trim();
  const seedActions: Array<{ action: InvestigationAction; rationale: string }> = [
    {
      action: {
        type: "search_temporary_memory",
        query: searchQuery || anchors.normalizedQuestion,
        limit: runtime.shared.budget.topKPerSearch
      },
      rationale: "Initial temporary working-context seed."
    },
    {
      action: {
        type: "search_memories",
        query: searchQuery || anchors.normalizedQuestion,
        limit: runtime.shared.budget.topKPerSearch
      },
      rationale: "Initial memory-layer seed."
    },
    {
      action: {
        type: "search_raw_sources",
        query: searchQuery || anchors.normalizedQuestion,
        limit: runtime.shared.budget.topKPerSearch
      },
      rationale: "Initial raw-source seed."
    }
  ];

  if (anchors.filePath) {
    seedActions.push({
      action: {
        type: "find_related_commits",
        filePath: anchors.filePath,
        limit: runtime.shared.budget.topKPerSearch
      },
      rationale: "Initial file-to-commit seed."
    });
  } else if (anchors.commitHash) {
    seedActions.push({
      action: {
        type: "read_commit",
        hash: anchors.commitHash
      },
      rationale: "Initial commit anchor seed."
    });
  }

  if (anchors.filePath) {
    const decisionMatches = findDecisions(runtime.store, { limit: runtime.shared.budget.topKPerSearch });
    addDecisions(runtime.shared, decisionMatches);
  } else if (anchors.decisionLike) {
    const decisionMatches = findDecisions(runtime.store, {
      topic: anchors.normalizedQuestion,
      limit: runtime.shared.budget.topKPerSearch
    });
    addDecisions(runtime.shared, decisionMatches);
  }

  for (const seed of seedActions) {
    if (runtime.shared.totalSteps >= runtime.shared.budget.maxSteps) {
      runtime.shared.terminationReason = "max_steps";
      return;
    }
    const executed = executeAction(runtime.store, seed.action, runtime.shared.budget);
    const newEvidence = applyObservation(runtime.shared, executed);
    appendStep(runtime.shared, {
      node,
      action: seed.action,
      actionInput: actionInputFromAction(seed.action),
      observationSummary: executed.summary,
      newEvidence,
      plannerRationale: seed.rationale,
      status: "completed"
    });
  }
}

async function runNode(runtime: InvestigationRuntime, node: RuntimeNode): Promise<void> {
  let localSteps = 0;

  while (runtime.shared.terminationReason === undefined) {
    if (runtime.shared.totalSteps >= runtime.shared.budget.maxSteps) {
      runtime.shared.terminationReason = "max_steps";
      return;
    }
    if (localSteps >= node.stepBudget) {
      if (node.depth >= runtime.shared.budget.maxDepth) {
        runtime.shared.terminationReason ??= "max_depth";
      }
      return;
    }
    if (runtime.shared.noNewEvidenceStreak >= 2) {
      runtime.shared.terminationReason = "no_new_evidence";
      return;
    }
    if (runtime.shared.plannerSteps > 0 && localSteps > 0 && meetsEvidenceThreshold(runtime.shared)) {
      runtime.shared.terminationReason = "evidence_threshold";
      return;
    }

    const plannerState = buildPlannerState(runtime.shared, node);
    const decision = await requestNextAction(runtime.provider, plannerState, runtime.shared, node);
    if (!decision) {
      if (runtime.shared.terminationReason === undefined) {
        runtime.shared.terminationReason = "invalid_action";
      }
      return;
    }

    const actionKey = normalizeActionKey(decision.action);
    if (runtime.shared.visitedActionKeys.has(actionKey)) {
      appendStep(runtime.shared, {
        node,
        action: decision.action,
        actionInput: actionInputFromAction(decision.action),
        observationSummary: "Skipped repeated action.",
        newEvidence: [],
        plannerRationale: decision.rationale,
        status: "skipped"
      });
      runtime.shared.plannerSteps += 1;
      runtime.shared.noNewEvidenceStreak += 1;
      localSteps += 1;
      continue;
    }

    runtime.shared.visitedActionKeys.add(actionKey);
    runtime.shared.plannerSteps += 1;

    if (decision.action.type === "finalize_answer") {
      appendStep(runtime.shared, {
        node,
        action: decision.action,
        actionInput: {},
        observationSummary: "Planner finalized the investigation.",
        newEvidence: [],
        plannerRationale: decision.rationale,
        status: "completed"
      });
      runtime.shared.terminationReason = "finalize_answer";
      return;
    }

    if (decision.action.type === "spawn_subinvestigation") {
      const spawnStepId = appendStep(runtime.shared, {
        node,
        action: decision.action,
        actionInput: actionInputFromAction(decision.action),
        observationSummary:
          node.depth >= runtime.shared.budget.maxDepth
            ? "Skipped child investigation at max depth."
            : "Spawned a child investigation.",
        newEvidence: [],
        plannerRationale: decision.rationale,
        status: node.depth >= runtime.shared.budget.maxDepth ? "skipped" : "completed"
      });
      localSteps += 1;
      if (node.depth >= runtime.shared.budget.maxDepth) {
        runtime.shared.terminationReason ??= "max_depth";
        return;
      }
      if (node.spawnedChildren >= runtime.shared.budget.maxBranching) {
        runtime.shared.noNewEvidenceStreak += 1;
        continue;
      }

      node.spawnedChildren += 1;
      const childBudget = Math.max(
        1,
        Math.min(
          node.stepBudget - localSteps,
          Math.floor((runtime.shared.budget.maxSteps - runtime.shared.totalSteps) / (runtime.shared.budget.maxBranching + 1))
        )
      );
      const childNode: RuntimeNode = {
        id: createNodeId(runtime.shared),
        question: decision.action.question,
        depth: node.depth + 1,
        stepBudget: childBudget,
        parentNodeId: node.id,
        parentStepId: spawnStepId,
        spawnedChildren: 0
      };
      if (decision.action.targetEntity) childNode.targetEntity = decision.action.targetEntity;
      if (decision.action.targetEntity) markVisitedEntity(runtime.shared, decision.action.targetEntity);

      setSpawnedChildren(runtime.shared, spawnStepId, [childNode.id]);
      await runNode(runtime, childNode);
      continue;
    }

    const executed = executeAction(runtime.store, decision.action, runtime.shared.budget);
    const newEvidence = applyObservation(runtime.shared, executed);
    appendStep(runtime.shared, {
      node,
      action: decision.action,
      actionInput: actionInputFromAction(decision.action),
      observationSummary: executed.summary,
      newEvidence,
      plannerRationale: decision.rationale,
      status: "completed"
    });
    runtime.shared.noNewEvidenceStreak = newEvidence.length === 0 ? runtime.shared.noNewEvidenceStreak + 1 : 0;
    localSteps += 1;
  }
}

async function requestNextAction(
  provider: InvestigatorProvider,
  state: ReturnType<typeof buildPlannerState>,
  shared: SharedInvestigationState,
  node: RuntimeNode
): Promise<{ action: InvestigationAction; rationale: string } | undefined> {
  const invalidSummaries: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryReason = invalidSummaries.at(-1);
    try {
      const decision = await provider.planNextAction(state, retryReason ? { retryReason } : undefined);
      const parsed = investigationActionSchema.safeParse(decision.action);
      if (parsed.success) {
        return {
          action: parsed.data,
          rationale: decision.rationale.trim() || "Planner selected an action."
        };
      }

      const summary = parsed.error.issues.map((issue) => issue.message).join("; ") || "invalid action";
      invalidSummaries.push(summary);
      appendStep(shared, {
        node,
        action: { type: "finalize_answer" },
        actionInput: {
          plannerOutput: decision.action as unknown as Record<string, unknown>,
          validationError: summary
        },
        observationSummary: `Planner output validation failed: ${summary}.`,
        newEvidence: [],
        plannerRationale: decision.rationale.trim() || "Planner returned invalid output.",
        status: "failed"
      });
      shared.noNewEvidenceStreak += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      invalidSummaries.push(message);
      appendStep(shared, {
        node,
        action: { type: "finalize_answer" },
        actionInput: { plannerError: message },
        observationSummary: `Planner request failed: ${message}.`,
        newEvidence: [],
        plannerRationale: "Planner request failed.",
        status: "failed"
      });
      shared.noNewEvidenceStreak += 1;
    }
  }

  appendStep(shared, {
    node,
    action: { type: "finalize_answer" },
    actionInput: {},
    observationSummary: "Finalizing with current evidence after invalid planner output.",
    newEvidence: [],
    plannerRationale: "Planner output remained invalid after retry.",
    status: "completed"
  });
  shared.terminationReason = "invalid_action";
  return undefined;
}

function executeAction(
  store: MemoryStore,
  action: InvestigationAction,
  budget: InvestigationBudget
): ExecutedObservation {
  switch (action.type) {
    case "search_temporary_memory": {
      const temporarySearchInput: Parameters<MemoryStore["searchTemporaryMemory"]>[0] = {
        query: action.query,
        limit: action.limit ?? budget.topKPerSearch
      };
      if (action.threadId !== undefined) temporarySearchInput.threadId = action.threadId;
      if (action.sessionId !== undefined) temporarySearchInput.sessionId = action.sessionId;
      const temporaryMemories = store.searchTemporaryMemory(temporarySearchInput);
      return {
        summary:
          temporaryMemories.length > 0
            ? `Found ${temporaryMemories.length} temporary working-context matches.`
            : "No temporary working-context matches found.",
        evidence: uniqueEvidence(temporaryMemories.flatMap((memory) => memory.evidence)),
        temporaryMemories,
        visitedEntities: [
          ...temporaryMemories.map((memory) => ({ entityType: "temporary_memory" as const, entityId: memory.id })),
          ...temporaryMemories.flatMap((memory) =>
            memory.relatedFiles.map((filePath) => ({ entityType: "file" as const, entityId: filePath }))
          )
        ]
      };
    }
    case "search_memories": {
      const limit = action.limit ?? budget.topKPerSearch;
      const promoted = action.status === "candidate" ? [] : store.listMemories({ query: action.query, limit });
      const candidates =
        action.status === "promoted" ? [] : store.listMemoryCandidates({ query: action.query, limit });
      const memorySearchInput: Parameters<MemoryStore["searchMemoryLayer"]>[0] = {
        query: action.query,
        limit
      };
      if (action.status) memorySearchInput.status = action.status;
      const memoryResults = store.searchMemoryLayer(memorySearchInput);
      return {
        summary: memoryResults.length > 0 ? `Found ${memoryResults.length} memory matches.` : "No memory matches found.",
        evidence: uniqueEvidence(memoryResults.flatMap((memory) => memory.evidence)),
        memoryResults,
        relatedMemories: promoted,
        candidateMemories: candidates,
        visitedEntities: [
          ...promoted.map((memory) => ({ entityType: "memory" as const, entityId: memory.id })),
          ...candidates.map((memory) => ({ entityType: "candidate" as const, entityId: memory.id })),
          ...memoryResults.flatMap((memory) =>
            memory.relatedFiles.map((filePath) => ({ entityType: "file" as const, entityId: filePath }))
          )
        ]
      };
    }
    case "search_raw_sources": {
      const searchInput: Parameters<MemoryStore["search"]>[0] = {
        query: action.query,
        limit: action.limit ?? budget.topKPerSearch
      };
      if (action.sourceTypes) searchInput.sourceTypes = action.sourceTypes;
      const results = store.search(searchInput);
      return {
        summary: results.length > 0 ? `Found ${results.length} raw source matches.` : "No raw source matches found.",
        evidence: results.map((result) => result.evidence),
        searchResults: results,
        visitedEntities: [
          ...results.map((result) => ({ entityType: "source" as const, entityId: result.sourceId })),
          ...results.map((result) => ({ entityType: "chunk" as const, entityId: result.chunkId }))
        ]
      };
    }
    case "find_related_commits": {
      const commitInput: Parameters<MemoryStore["findCommits"]>[0] = {
        limit: action.limit ?? budget.topKPerSearch
      };
      if (action.query) commitInput.query = action.query;
      if (action.filePath) commitInput.filePath = action.filePath;
      const commits = store.findCommits(commitInput);
      return {
        summary: commits.length > 0 ? `Found ${commits.length} related commits.` : "No related commits found.",
        evidence: commits.map((commit) => ({ sourceType: "commit" as const, sourceId: commit.hash })),
        commits,
        visitedEntities: [
          ...commits.map((commit) => ({ entityType: "commit" as const, entityId: commit.hash })),
          ...commits.flatMap((commit) =>
            commit.changedFiles.map((filePath) => ({ entityType: "file" as const, entityId: filePath }))
          )
        ]
      };
    }
    case "read_source": {
      const source = store.readSource(action.sourceId);
      const evidence = source ? [sourceToEvidence(source)] : [];
      const relatedDecisions =
        source?.type === "decision" ? optionalArray(readDecisionRecord(store, action.sourceId)) : [];
      return {
        summary: source ? `Read source ${action.sourceId}.` : `Source ${action.sourceId} was not found.`,
        evidence,
        source,
        relatedDecisions,
        visitedEntities: source ? [{ entityType: "source", entityId: action.sourceId }] : []
      };
    }
    case "read_conversation_window": {
      const before = action.before ?? 1;
      const after = action.after ?? 1;
      const chunks = action.anchorChunkId
        ? store.readConversationWindow(action.sourceId, action.anchorChunkId, before, after)
        : store.readChunkWindow(action.sourceId, action.chunkIndex ?? 0, before, after);
      return {
        summary: chunks.length > 0 ? `Read ${chunks.length} conversation chunks.` : "No conversation window found.",
        evidence: chunks.map((chunk) => ({
          sourceType: "conversation" as const,
          sourceId: action.sourceId,
          locator: chunk.id
        })).filter(isDefinedLocatorEvidence),
        chunks,
        visitedEntities: [
          { entityType: "source" as const, entityId: action.sourceId },
          ...chunks
            .filter((chunk): chunk is typeof chunk & { id: string } => typeof chunk.id === "string")
            .map((chunk) => ({ entityType: "chunk" as const, entityId: chunk.id }))
        ]
      };
    }
    case "read_commit": {
      const commit = store.readCommit(action.hash);
      return {
        summary: commit ? `Read commit ${action.hash}.` : `Commit ${action.hash} was not found.`,
        evidence: commit ? [{ sourceType: "commit", sourceId: commit.hash }] : [],
        commit,
        commits: optionalArray(commit),
        visitedEntities: commit
          ? [
              { entityType: "commit", entityId: commit.hash },
              ...commit.changedFiles.map((filePath) => ({ entityType: "file" as const, entityId: filePath }))
            ]
          : []
      };
    }
    case "follow_evidence_refs": {
      const limit = action.limit ?? budget.topKPerSearch;
      const commits: CommitRecord[] = [];
      const sources: MemorySource[] = [];
      const chunks: Array<NonNullable<ExecutedObservation["chunks"]>[number]> = [];
      const decisions: DecisionRecord[] = [];
      const visitedEntities: InvestigationEntityRef[] = [];
      for (const evidence of action.evidence.slice(0, limit)) {
        if (evidence.sourceType === "commit") {
          const commit = store.readCommit(evidence.sourceId);
          if (commit) {
            commits.push(commit);
            visitedEntities.push({ entityType: "commit", entityId: commit.hash });
          }
          continue;
        }

        const source = store.readSource(evidence.sourceId);
        if (source) {
          sources.push(source);
          visitedEntities.push({ entityType: "source", entityId: evidence.sourceId });
        }
        if (evidence.locator?.includes(":chunk:")) {
          const window = store.readConversationWindow(evidence.sourceId, evidence.locator, 1, 1);
          chunks.push(...window);
          for (const chunk of window) {
            if (chunk.id) visitedEntities.push({ entityType: "chunk", entityId: chunk.id });
          }
        }
        if (evidence.sourceType === "decision") {
          const decision = readDecisionRecord(store, evidence.sourceId);
          if (decision) decisions.push(decision);
        }
      }
      return {
        summary:
          commits.length + sources.length + chunks.length + decisions.length > 0
            ? "Followed evidence references."
            : "Evidence references did not resolve to new records.",
        evidence: [
          ...commits.map((commit) => ({ sourceType: "commit" as const, sourceId: commit.hash })),
          ...sources.map(sourceToEvidence),
          ...chunks
            .filter((chunk) => chunk.id)
            .map((chunk) => ({ sourceType: "conversation" as const, sourceId: action.evidence[0]?.sourceId ?? "", locator: chunk.id }))
        ],
        commits,
        sources,
        chunks,
        relatedDecisions: decisions,
        visitedEntities
      };
    }
    case "expand_entity_links": {
      const limit = action.limit ?? budget.topKPerSearch;
      const entityLinks = store.getEntityLinks(action.entity).slice(0, limit);
      const commits =
        action.entity.entityType === "file" ? store.findCommits({ filePath: action.entity.entityId, limit }) : [];
      const sources =
        action.entity.entityType === "file" ? store.findSourcesMentioningFile(action.entity.entityId, limit) : [];
      return {
        summary:
          entityLinks.length > 0 ? `Expanded ${entityLinks.length} entity links.` : "No entity links were found.",
        evidence: uniqueEvidence([
          ...entityLinks.flatMap(entityLinkToEvidence),
          ...commits.map((commit) => ({ sourceType: "commit" as const, sourceId: commit.hash })),
          ...sources.map(sourceToEvidence)
        ]),
        entityLinks,
        commits,
        sources,
        visitedEntities: [
          action.entity,
          ...entityLinks.map((link) => ({
            entityType: link.targetType as InvestigationEntityRef["entityType"],
            entityId: link.targetId
          })),
          ...sources.map((source) => ({ entityType: "source" as const, entityId: source.id ?? "" })),
          ...commits.map((commit) => ({ entityType: "commit" as const, entityId: commit.hash }))
        ].filter((entity) => entity.entityId.length > 0)
      };
    }
    case "spawn_subinvestigation":
    case "finalize_answer":
      return {
        summary: "No deterministic execution for planner control action.",
        evidence: []
      };
  }
}

function applyObservation(shared: SharedInvestigationState, observation: ExecutedObservation): EvidenceRef[] {
  const newEvidence = addEvidence(shared, observation.evidence);
  addSearchResults(shared, observation.searchResults ?? []);
  addTemporaryMemories(shared, observation.temporaryMemories ?? []);
  addCommits(shared, observation.commits ?? optionalArray(observation.commit));
  addDecisions(shared, observation.relatedDecisions ?? []);
  addMemories(shared, observation.relatedMemories ?? [], observation.candidateMemories ?? []);

  for (const entity of observation.visitedEntities ?? []) {
    markVisitedEntity(shared, entity);
  }

  return newEvidence;
}

async function synthesizeFinalAnswer(
  runtime: InvestigationRuntime,
  state: ReturnType<typeof buildPlannerState>,
  anchors: InvestigationAnchors
): Promise<{ answer: string; evidenceScore: number }> {
  try {
    return await runtime.provider.synthesizeAnswer(state);
  } catch {
    const answer = anchors.filePath
      ? buildFileAnswer(
          anchors.filePath,
          [...runtime.shared.temporaryMemories.values()],
          [...runtime.shared.relatedMemories.values()],
          [...runtime.shared.relatedCommits.values()],
          [...runtime.shared.searchResults.values()],
          [...runtime.shared.relatedDecisions.values()]
        )
      : buildQuestionAnswer(
          runtime.shared.rootQuestion,
          [...runtime.shared.temporaryMemories.values()],
          [...runtime.shared.relatedMemories.values()],
          [...runtime.shared.searchResults.values()],
          [...runtime.shared.relatedCommits.values()],
          [...runtime.shared.relatedDecisions.values()]
        );
    return {
      answer,
      evidenceScore: computeEvidenceScore([...runtime.shared.evidence.values()])
    };
  }
}

function buildHeuristicFallback(
  store: MemoryStore,
  input: { question: string; filePath?: string; limit: number }
): InvestigationResult {
  const query = [input.filePath, input.question].filter(Boolean).join(" ").trim();
  const temporaryMemories = store.searchTemporaryMemory({ query: query || input.question, limit: 5 });
  const relatedMemories = store.listMemories({ query: query || input.question, limit: 5 });
  const candidateMemories = store.listMemoryCandidates({ query: query || input.question, limit: 5 });
  const relatedCommits = input.filePath
    ? store.findCommits({ filePath: input.filePath, limit: input.limit })
    : store.findCommits({ query: input.question, limit: input.limit });
  const fallbackSearchInput: Parameters<MemoryStore["search"]>[0] = {
    query: query || input.question,
    limit: input.limit
  };
  if (input.filePath) fallbackSearchInput.sourceTypes = ["conversation", "decision"];
  const searchResults = store.search(fallbackSearchInput);
  const relatedDecisions = input.filePath
    ? findDecisions(store, { limit: 5 })
    : findDecisions(store, { topic: input.question, limit: 5 });
  const evidence = uniqueEvidence([
    ...temporaryMemories.flatMap((memory) => memory.evidence),
    ...relatedMemories.flatMap((memory) => memory.evidence),
    ...candidateMemories.flatMap((memory) => memory.evidence),
    ...relatedCommits.map((commit) => ({ sourceType: "commit" as const, sourceId: commit.hash })),
    ...searchResults.map((result) => result.evidence),
    ...relatedDecisions.map((decision) => ({ sourceType: "decision" as const, sourceId: decision.id }))
  ]);
  const trace: InvestigationTrace = {
    steps: [
      createHeuristicStep(
        "heuristic-step-1",
        {
          type: "search_temporary_memory",
          query: query || input.question,
          limit: 5
        },
        `Collected ${temporaryMemories.length} temporary working-context matches.`
      ),
      createHeuristicStep(
        "heuristic-step-2",
        {
          type: "search_memories",
          query: query || input.question,
          limit: 5
        },
        `Collected ${relatedMemories.length + candidateMemories.length} memory-layer matches.`
      ),
      createHeuristicStep(
        "heuristic-step-3",
        {
          type: "search_raw_sources",
          query: query || input.question,
          limit: input.limit
        },
        `Collected ${searchResults.length} raw source matches.`
      ),
      createHeuristicStep(
        "heuristic-step-4",
        input.filePath
          ? {
              type: "find_related_commits",
              filePath: input.filePath,
              limit: input.limit
            }
          : {
              type: "find_related_commits",
              query: input.question,
              limit: input.limit
            },
        `Collected ${relatedCommits.length} related commits.`
      ),
      createHeuristicStep("heuristic-step-5", { type: "finalize_answer" }, "Finalized with heuristic investigation.")
    ]
  };

  return {
    answer: input.filePath
      ? buildFileAnswer(input.filePath, temporaryMemories, relatedMemories, relatedCommits, searchResults, relatedDecisions)
      : buildQuestionAnswer(input.question, temporaryMemories, relatedMemories, searchResults, relatedCommits, relatedDecisions),
    evidence,
    searchResults,
    relatedCommits,
    relatedDecisions,
    temporaryMemories,
    relatedMemories,
    candidateMemories,
    mode: "heuristic-fallback",
    status: evidence.length > 0 ? "complete" : "partial",
    trace,
    terminationReason: "heuristic_fallback",
    evidenceScore: computeEvidenceScore(evidence),
    visitedEntities: collectVisitedEntitiesFromFallback(
      relatedMemories,
      candidateMemories,
      temporaryMemories,
      relatedCommits,
      searchResults,
      relatedDecisions
    )
  };
}

function finalizeResult(
  store: MemoryStore,
  question: string,
  filePath: string | undefined,
  shared: SharedInvestigationState,
  answer: string,
  evidenceScore: number
): InvestigationResult {
  const relatedMemories = [...shared.relatedMemories.values()];
  const candidateMemories = [...shared.candidateMemories.values()];
  const temporaryMemories = [...shared.temporaryMemories.values()];
  const relatedCommits = [...shared.relatedCommits.values()];
  const searchResults = [...shared.searchResults.values()];
  const relatedDecisions = [...shared.relatedDecisions.values()];
  const evidence = [...shared.evidence.values()];

  return {
    answer:
      answer.trim() ||
      (filePath
        ? buildFileAnswer(filePath, temporaryMemories, relatedMemories, relatedCommits, searchResults, relatedDecisions)
        : buildQuestionAnswer(question, temporaryMemories, relatedMemories, searchResults, relatedCommits, relatedDecisions)),
    evidence,
    searchResults,
    relatedCommits,
    relatedDecisions,
    temporaryMemories,
    relatedMemories,
    candidateMemories,
    mode: shared.mode,
    status: statusFromTermination(shared.terminationReason, evidence.length),
    trace: {
      steps: shared.traceSteps
    },
    terminationReason: shared.terminationReason ?? "finalize_answer",
    evidenceScore,
    visitedEntities: [...shared.visitedEntities]
  };
}

function createSharedState(rootQuestion: string, budget: InvestigationBudget): SharedInvestigationState {
  return {
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
    nextNodeNumber: 1,
    totalSteps: 0,
    plannerSteps: 0,
    noNewEvidenceStreak: 0
  };
}

function buildPlannerState(
  shared: SharedInvestigationState,
  node: RuntimeNode
): {
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
  temporaryMemories: TemporaryMemorySearchResult[];
  relatedMemories: DurableMemory[];
  candidateMemories: MemoryCandidate[];
  searchResults: SearchResult[];
} {
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

function budgetFromConfig(config: InvestigatorConfig): InvestigationBudget {
  return {
    maxDepth: config.maxDepth,
    maxSteps: config.maxSteps,
    maxBranching: config.maxBranching,
    topKPerSearch: config.topKPerSearch,
    evidenceThreshold: config.evidenceThreshold
  };
}

function resolveInvestigatorProvider(options: InvestigationRunOptions): InvestigatorProvider | undefined {
  if (options.investigatorProvider) return options.investigatorProvider;
  const config = options.config?.investigator;
  if (!config?.enabled) return undefined;
  if (!hasProviderCredentials(config)) return undefined;
  if (config.provider === "anthropic-aws") {
    return createAnthropicAwsInvestigator(config);
  }
  return createOpenAICompatibleInvestigator(config);
}

function hasProviderCredentials(config: InvestigatorConfig): boolean {
  if (!process.env[config.apiKeyEnv]?.trim()) return false;
  if (config.provider !== "anthropic-aws") return true;
  const workspaceIdEnv = config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID";
  const regionEnv = config.regionEnv ?? "AWS_REGION";
  return Boolean(process.env[workspaceIdEnv]?.trim() && process.env[regionEnv]?.trim());
}

function deriveAnchors(
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

function appendStep(
  shared: SharedInvestigationState,
  input: {
    node: RuntimeNode;
    action: InvestigationAction;
    actionInput: Record<string, unknown>;
    observationSummary: string;
    newEvidence: EvidenceRef[];
    plannerRationale: string;
    status: InvestigationStep["status"];
  }
): string {
  const step: InvestigationStep = {
    stepId: `step-${shared.nextStepNumber++}`,
    depth: input.node.depth,
    action: input.action,
    actionInput: input.actionInput,
    observationSummary: input.observationSummary,
    newEvidence: input.newEvidence,
    spawnedChildren: [],
    plannerRationale: input.plannerRationale,
    status: input.status
  };
  if (input.node.parentStepId) step.parentStepId = input.node.parentStepId;
  shared.traceSteps.push(step);
  shared.totalSteps += 1;
  return step.stepId;
}

function setSpawnedChildren(shared: SharedInvestigationState, stepId: string, childIds: string[]): void {
  const step = shared.traceSteps.find((item) => item.stepId === stepId);
  if (!step) return;
  step.spawnedChildren = childIds;
}

function addEvidence(shared: SharedInvestigationState, evidence: EvidenceRef[]): EvidenceRef[] {
  const unique: EvidenceRef[] = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (shared.evidence.has(key)) continue;
    shared.evidence.set(key, item);
    unique.push(item);
  }
  return unique;
}

function addSearchResults(shared: SharedInvestigationState, searchResults: SearchResult[]): void {
  for (const result of searchResults) {
    const key = `${result.sourceId}:${result.chunkId}`;
    if (!shared.searchResults.has(key)) shared.searchResults.set(key, result);
    markVisitedEntity(shared, { entityType: "source", entityId: result.sourceId });
    markVisitedEntity(shared, { entityType: "chunk", entityId: result.chunkId });
  }
}

function addCommits(shared: SharedInvestigationState, commits: CommitRecord[]): void {
  for (const commit of commits) {
    if (!shared.relatedCommits.has(commit.hash)) shared.relatedCommits.set(commit.hash, commit);
    markVisitedEntity(shared, { entityType: "commit", entityId: commit.hash });
    for (const filePath of commit.changedFiles) {
      markVisitedEntity(shared, { entityType: "file", entityId: filePath });
    }
  }
}

function addDecisions(shared: SharedInvestigationState, decisions: DecisionRecord[]): void {
  for (const decision of decisions) {
    if (!shared.relatedDecisions.has(decision.id)) shared.relatedDecisions.set(decision.id, decision);
    markVisitedEntity(shared, { entityType: "decision", entityId: decision.id });
  }
}

function addTemporaryMemories(
  shared: SharedInvestigationState,
  temporaryMemories: TemporaryMemorySearchResult[]
): void {
  for (const memory of temporaryMemories) {
    if (!shared.temporaryMemories.has(memory.id)) shared.temporaryMemories.set(memory.id, memory);
    markVisitedEntity(shared, { entityType: "temporary_memory", entityId: memory.id });
    for (const filePath of memory.relatedFiles) {
      markVisitedEntity(shared, { entityType: "file", entityId: filePath });
    }
  }
}

function addMemories(
  shared: SharedInvestigationState,
  memories: DurableMemory[],
  candidates: MemoryCandidate[]
): void {
  for (const memory of memories) {
    if (!shared.relatedMemories.has(memory.id)) shared.relatedMemories.set(memory.id, memory);
    markVisitedEntity(shared, { entityType: "memory", entityId: memory.id });
    for (const filePath of memory.relatedFiles) {
      markVisitedEntity(shared, { entityType: "file", entityId: filePath });
    }
  }
  for (const candidate of candidates) {
    if (!shared.candidateMemories.has(candidate.id)) shared.candidateMemories.set(candidate.id, candidate);
    markVisitedEntity(shared, { entityType: "candidate", entityId: candidate.id });
    for (const filePath of candidate.relatedFiles) {
      markVisitedEntity(shared, { entityType: "file", entityId: filePath });
    }
  }
}

function markVisitedEntity(
  shared: SharedInvestigationState,
  entity: InvestigationEntityRef,
  enabled = true
): void {
  if (!enabled || !entity.entityId) return;
  shared.visitedEntities.add(entityKey(entity));
}

function computeEvidenceScore(evidence: EvidenceRef[]): number {
  const categories = new Set(evidence.map((item) => item.sourceType));
  const directCitations = evidence.filter((item) => item.locator).length;
  const rawScore = categories.size * 0.3 + Math.min(evidence.length, 4) * 0.1 + Math.min(directCitations, 2) * 0.15;
  return Number(Math.min(1, rawScore).toFixed(2));
}

function meetsEvidenceThreshold(shared: SharedInvestigationState): boolean {
  const evidence = [...shared.evidence.values()];
  const categories = new Set(evidence.map((item) => item.sourceType));
  const hasDirectCitation = evidence.some((item) => item.locator);
  if (categories.size >= 2 && evidence.length >= 2) {
    return computeEvidenceScore(evidence) >= shared.budget.evidenceThreshold;
  }
  if (hasDirectCitation && evidence.length >= 2) {
    return computeEvidenceScore(evidence) >= shared.budget.evidenceThreshold;
  }
  return false;
}

function statusFromTermination(
  terminationReason: InvestigationTerminationReason | undefined,
  evidenceCount: number
): InvestigationResult["status"] {
  if (terminationReason === "max_steps" || terminationReason === "max_depth" || terminationReason === "no_new_evidence") {
    return evidenceCount > 0 ? "partial" : "failed";
  }
  if (terminationReason === "invalid_action") {
    return evidenceCount > 0 ? "partial" : "failed";
  }
  return evidenceCount > 0 ? "complete" : "partial";
}

function buildFileAnswer(
  filePath: string,
  temporaryMemories: TemporaryMemorySearchResult[],
  memories: DurableMemory[],
  commits: CommitRecord[],
  searchResults: SearchResult[],
  decisions: DecisionRecord[]
): string {
  const lines = [`Found project history for ${filePath}.`];
  if (temporaryMemories.length > 0) {
    lines.push(`Temporary working context: ${temporaryMemories[0]?.summary}`);
  }
  if (memories.length > 0) {
    lines.push(`Promoted memory: ${memories[0]?.summary}`);
  }
  if (commits.length > 0) {
    lines.push(`Most recent related commit: ${commits[0]?.message} (${commits[0]?.hash}).`);
  }
  if (decisions.length > 0) {
    lines.push(`Relevant decision: ${decisions[0]?.decision} because ${decisions[0]?.reason}.`);
  }
  if (searchResults.length > 0) {
    lines.push(`Relevant discussion: ${searchResults[0]?.text}`);
  }
  if (lines.length === 1) {
    lines.push("No related commits, decisions, or conversation evidence were found in local memory.");
  }
  return lines.join("\n");
}

function buildQuestionAnswer(
  question: string,
  temporaryMemories: TemporaryMemorySearchResult[],
  memories: DurableMemory[],
  searchResults: SearchResult[],
  commits: CommitRecord[],
  decisions: DecisionRecord[]
): string {
  const lines = [`Investigated: ${question}`];
  if (temporaryMemories.length > 0) {
    lines.push(`Temporary working context: ${temporaryMemories[0]?.summary}`);
  }
  if (memories.length > 0) {
    lines.push(`Promoted memory: ${memories[0]?.summary}`);
  }
  if (searchResults.length > 0) {
    lines.push(`Most relevant evidence: ${searchResults[0]?.text}`);
  }
  if (commits.length > 0) {
    lines.push(`Related commit: ${commits[0]?.message} (${commits[0]?.hash}).`);
  }
  if (decisions.length > 0) {
    lines.push(`Related decision: ${decisions[0]?.decision}.`);
  }
  if (lines.length === 1) {
    lines.push("No matching local project memory was found.");
  }
  return lines.join("\n");
}

function sourceToEvidence(source: MemorySource): EvidenceRef {
  return {
    sourceType: source.type,
    sourceId: source.id ?? source.title
  };
}

function entityLinkToEvidence(link: InvestigationEntityLink): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  if (link.sourceType === "commit" || link.sourceType === "conversation" || link.sourceType === "decision") {
    evidence.push({
      sourceType: link.sourceType,
      sourceId: link.sourceId,
      locator: link.locator
    });
  }
  if (
    link.targetType === "commit" ||
    link.targetType === "conversation" ||
    link.targetType === "decision"
  ) {
    evidence.push({
      sourceType: link.targetType,
      sourceId: link.targetId,
      locator: link.locator
    });
  }
  return evidence;
}

function readDecisionRecord(store: MemoryStore, decisionId: string): DecisionRecord | undefined {
  return findDecisions(store, { limit: 1000 }).find((decision) => decision.id === decisionId);
}

function uniqueEvidence<T extends EvidenceRef>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function evidenceKey(evidence: EvidenceRef): string {
  return `${evidence.sourceType}:${evidence.sourceId}:${evidence.locator ?? ""}`;
}

function entityKey(entity: InvestigationEntityRef): string {
  return `${entity.entityType}:${entity.entityId}`;
}

function normalizeActionKey(action: InvestigationAction): string {
  return JSON.stringify(sortKeys(action as unknown as Record<string, unknown>));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortKeys(nested)])
    );
  }
  return value;
}

function createNodeId(shared: SharedInvestigationState): string {
  return `node-${shared.nextNodeNumber++}`;
}

function optionalArray<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

function createHeuristicStep(stepId: string, action: InvestigationAction, observationSummary: string): InvestigationStep {
  return {
    stepId,
    depth: 0,
    action,
    actionInput: actionInputFromAction(action),
    observationSummary,
    newEvidence: [],
    spawnedChildren: [],
    plannerRationale: "Heuristic fallback step.",
    status: "completed"
  };
}

function collectVisitedEntitiesFromFallback(
  memories: DurableMemory[],
  candidates: MemoryCandidate[],
  temporaryMemories: TemporaryMemorySearchResult[],
  commits: CommitRecord[],
  searchResults: SearchResult[],
  decisions: DecisionRecord[]
): string[] {
  const visited = new Set<string>();
  for (const memory of temporaryMemories) {
    visited.add(`temporary_memory:${memory.id}`);
    for (const filePath of memory.relatedFiles) visited.add(`file:${filePath}`);
  }
  for (const memory of memories) {
    visited.add(`memory:${memory.id}`);
    for (const filePath of memory.relatedFiles) visited.add(`file:${filePath}`);
  }
  for (const candidate of candidates) {
    visited.add(`candidate:${candidate.id}`);
    for (const filePath of candidate.relatedFiles) visited.add(`file:${filePath}`);
  }
  for (const commit of commits) {
    visited.add(`commit:${commit.hash}`);
    for (const filePath of commit.changedFiles) visited.add(`file:${filePath}`);
  }
  for (const result of searchResults) {
    visited.add(`source:${result.sourceId}`);
    visited.add(`chunk:${result.chunkId}`);
  }
  for (const decision of decisions) {
    visited.add(`decision:${decision.id}`);
  }
  return [...visited];
}

function actionInputFromAction(action: InvestigationAction): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(action as Record<string, unknown>).filter(([key]) => key !== "type")
  );
}

function isDefinedLocatorEvidence(
  evidence: EvidenceRef | { sourceType: "conversation"; sourceId: string; locator: string | undefined }
): evidence is EvidenceRef {
  return typeof evidence.locator === "string" && evidence.locator.length > 0;
}
