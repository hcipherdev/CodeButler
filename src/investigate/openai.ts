import {
  investigationPlanDecisionSchema,
  investigationSynthesisSchema
} from "./actions.js";
import type {
  InvestigationPlannerState,
  InvestigatorConfig,
  InvestigatorProvider
} from "../types.js";

const INVESTIGATOR_SYSTEM_PROMPT = [
  "You are a project-history investigation planner.",
  "Choose exactly one next action from the allowed typed action set.",
  "Search temporary working context before durable memory when the task looks like continuation after compaction.",
  "Treat temporary memory as working context, not project truth, unless corroborated by source, commit, test, or code evidence.",
  "Prefer precise evidence over broad search.",
  "Do not repeat an identical action.",
  "Recurse only when a branch materially narrows the answer.",
  "Stop once the answer has at least two supporting evidence items from distinct categories, or one direct citation plus one corroborating source.",
  "Keep rationales short and operational.",
  "Respond with strict JSON shaped as {\"action\": {...}, \"rationale\": \"...\"}."
].join(" ");

const SYNTHESIS_SYSTEM_PROMPT = [
  "You are synthesizing a project-history answer from explicit evidence.",
  "Use only the provided evidence and trace summary.",
  "Label temporary memory as working context unless corroborated by durable evidence.",
  "Return strict JSON shaped as {\"answer\": \"...\", \"evidenceScore\": 0.0 }.",
  "Keep the answer concise and evidence-led."
].join(" ");

export function createOpenAICompatibleInvestigator(
  config: InvestigatorConfig,
  fetchImpl: typeof fetch = fetch
): InvestigatorProvider {
  return {
    async planNextAction(state, options) {
      const content = await requestJsonContent(
        fetchImpl,
        config,
        INVESTIGATOR_SYSTEM_PROMPT,
        {
          kind: "plan_next_action",
          retryReason: options?.retryReason,
          state: summarizePlannerState(state)
        }
      );
      const parsed = investigationPlanDecisionSchema.parse(JSON.parse(content));
      return parsed;
    },
    async synthesizeAnswer(state) {
      const content = await requestJsonContent(
        fetchImpl,
        config,
        SYNTHESIS_SYSTEM_PROMPT,
        {
          kind: "synthesize_answer",
          state: summarizePlannerState(state)
        }
      );
      const parsed = investigationSynthesisSchema.parse(JSON.parse(content));
      return parsed;
    }
  };
}

async function requestJsonContent(
  fetchImpl: typeof fetch,
  config: InvestigatorConfig,
  systemPrompt: string,
  payload: Record<string, unknown>
): Promise<string> {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[config.apiKeyEnv] ?? ""}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`Investigator request failed with status ${response.status}`);
  }

  return readCompletionContent(await response.json());
}

function summarizePlannerState(state: InvestigationPlannerState): Record<string, unknown> {
  return {
    mode: state.mode,
    rootQuestion: state.rootQuestion,
    question: state.question,
    depth: state.depth,
    budget: state.budget,
    node: state.node,
    evidence: state.evidence.slice(0, 20),
    visitedEntities: state.visitedEntities.slice(0, 40),
    searchResults: state.searchResults.slice(0, 5).map((result) => ({
      sourceId: result.sourceId,
      sourceType: result.sourceType,
      title: result.title,
      text: result.text,
      evidence: result.evidence
    })),
    relatedCommits: state.relatedCommits.slice(0, 5).map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      changedFiles: commit.changedFiles
    })),
    relatedDecisions: state.relatedDecisions.slice(0, 5).map((decision) => ({
      id: decision.id,
      topic: decision.topic,
      decision: decision.decision,
      reason: decision.reason
    })),
    temporaryMemories: (state.temporaryMemories ?? []).slice(0, 5).map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      title: memory.title,
      summary: memory.summary,
      details: memory.details,
      relatedFiles: memory.relatedFiles,
      evidence: memory.evidence,
      expiresAt: memory.expiresAt
    })),
    relatedMemories: state.relatedMemories.slice(0, 5).map((memory) => ({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      reason: memory.reason,
      relatedFiles: memory.relatedFiles,
      evidence: memory.evidence
    })),
    candidateMemories: state.candidateMemories.slice(0, 5).map((memory) => ({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      reason: memory.reason,
      relatedFiles: memory.relatedFiles,
      evidence: memory.evidence
    })),
    trace: state.trace.steps.slice(-8).map((step) => ({
      stepId: step.stepId,
      depth: step.depth,
      action: step.action,
      observationSummary: step.observationSummary,
      newEvidence: step.newEvidence,
      plannerRationale: step.plannerRationale,
      status: step.status
    }))
  };
}

function readCompletionContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((item) => {
        const part = asRecord(item);
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  throw new Error("Invalid investigator response");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
