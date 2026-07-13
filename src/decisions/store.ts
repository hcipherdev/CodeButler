import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DecisionRecord, EvidenceRef } from "../types.js";
import type { MemoryStore } from "../storage/store.js";
import { withTransaction } from "../storage/transactions.js";

export interface DecisionInput {
  topic: string;
  decision: string;
  reason: string;
  status: string;
  evidence: EvidenceRef[];
}

export function addDecision(store: MemoryStore, input: DecisionInput): DecisionRecord {
  return withTransaction(store.db, () => {
    const id = nextDecisionId(store);
    const createdAt = new Date().toISOString();
    const record: DecisionRecord = {
      id,
      topic: input.topic,
      decision: input.decision,
      reason: input.reason,
      status: input.status,
      evidence: input.evidence,
      createdAt
    };

    store.db
      .prepare(
        `insert into decisions (id, topic, decision, reason, status, evidence_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.topic,
        record.decision,
        record.reason,
        record.status,
        JSON.stringify(record.evidence),
        record.createdAt
      );

    store.addSourceWithChunks({
      source: {
        id: record.id,
        type: "decision",
        title: record.topic,
        origin: "manual-decision",
        rawContent: formatDecision(record),
        metadata: { status: record.status }
      },
      chunks: [
        {
          text: formatDecision(record),
          metadata: { decisionId: record.id, topic: record.topic }
        }
      ]
    });
    store.upsertManualDecisionMemory(record);

    const insertRelation = store.db.prepare(
      `insert into relations (id, from_type, from_id, relation, to_type, to_id, locator)
       values (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const evidence of record.evidence) {
      insertRelation.run(
        randomUUID(),
        "decision",
        record.id,
        "supported_by",
        evidence.sourceType,
        evidence.sourceId,
        evidence.locator ?? null
      );
    }

    return record;
  });
}

export function findDecisions(
  store: MemoryStore,
  input: { topic?: string; limit?: number }
): DecisionRecord[] {
  const limit = normalizeLimit(input.limit);
  const rows = store.db
    .prepare(
      `select id, topic, decision, reason, status, evidence_json, created_at
       from decisions
       order by created_at desc, id desc`
    )
    .all() as unknown as DecisionRow[];
  const topic = input.topic?.toLowerCase();
  const manualDecisions = rows
    .map(decisionFromRow)
    .filter((decision) => {
      if (!topic) return true;
      return [decision.topic, decision.decision, decision.reason].join(" ").toLowerCase().includes(topic);
    });
  const promotedMemoryQuery: Parameters<typeof store.listMemories>[0] = {
    type: "decision",
    status: "promoted",
    limit: limit * 3
  };
  if (input.topic !== undefined) promotedMemoryQuery.query = input.topic;
  const promotedDecisions = store
    .listMemories(promotedMemoryQuery)
    .filter((memory) => memory.source === "auto")
    .map<DecisionRecord>((memory) => ({
      id: memory.id,
      topic: memory.title,
      decision: memory.summary,
      reason: memory.reason,
      status: "promoted",
      evidence: memory.evidence,
      createdAt: memory.createdAt
    }));

  return [...manualDecisions, ...promotedDecisions]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export function importDecisionMarkdown(store: MemoryStore, filePath: string): DecisionRecord {
  const raw = readFileSync(filePath, "utf8");
  return addDecision(store, parseDecisionMarkdown(raw));
}

interface DecisionRow {
  id: string;
  topic: string;
  decision: string;
  reason: string;
  status: string;
  evidence_json: string;
  created_at: string;
}

function nextDecisionId(store: MemoryStore): string {
  const row = store.db.prepare("select count(*) as count from decisions").get() as { count: number };
  return `DEC-${String(row.count + 1).padStart(4, "0")}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

function decisionFromRow(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    topic: row.topic,
    decision: row.decision,
    reason: row.reason,
    status: row.status,
    evidence: parseEvidenceJson(row.evidence_json),
    createdAt: row.created_at
  };
}

function parseEvidenceJson(value: string): EvidenceRef[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEvidenceRef);
}

function parseDecisionMarkdown(raw: string): DecisionInput {
  const topic = parseTitle(raw);
  const status = parseField(raw, "Status") ?? "accepted";
  const decision = parseField(raw, "Decision");
  const reason = parseField(raw, "Reason");
  if (!decision) throw new Error("Decision markdown must include a Decision field");
  if (!reason) throw new Error("Decision markdown must include a Reason field");
  return {
    topic,
    decision,
    reason,
    status,
    evidence: parseEvidenceLines(raw)
  };
}

function parseTitle(raw: string): string {
  const match = raw.match(/^#\s*Decision:\s*(.+)$/im) ?? raw.match(/^#\s*(.+)$/im);
  if (!match?.[1]) throw new Error("Decision markdown must include a title");
  return match[1].trim();
}

function parseField(raw: string, field: string): string | undefined {
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function parseEvidenceLines(raw: string): EvidenceRef[] {
  const lines = raw.split(/\r?\n/);
  const evidence: EvidenceRef[] = [];
  let inEvidence = false;
  for (const line of lines) {
    if (/^Evidence:\s*$/i.test(line.trim())) {
      inEvidence = true;
      continue;
    }
    if (!inEvidence) continue;
    const match = line.trim().match(/^-\s*(conversation|commit|decision):([^#\s]+)(?:#(.+))?$/);
    if (!match) {
      if (line.trim().length === 0) continue;
      break;
    }
    const sourceType = match[1] as EvidenceRef["sourceType"];
    const sourceId = match[2];
    if (!sourceId) continue;
    const locator = match[3];
    evidence.push(locator ? { sourceType, sourceId, locator } : { sourceType, sourceId });
  }
  return evidence;
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.sourceType === "conversation" || record.sourceType === "commit" || record.sourceType === "decision") &&
    typeof record.sourceId === "string" &&
    (record.locator === undefined || typeof record.locator === "string")
  );
}

function formatDecision(record: DecisionRecord): string {
  return [
    `Decision: ${record.topic}`,
    `Status: ${record.status}`,
    `Decision: ${record.decision}`,
    `Reason: ${record.reason}`,
    "Evidence:",
    ...record.evidence.map(formatEvidence)
  ].join("\n");
}

function formatEvidence(evidence: EvidenceRef): string {
  return `- ${evidence.sourceType}:${evidence.sourceId}${evidence.locator ? `#${evidence.locator}` : ""}`;
}
