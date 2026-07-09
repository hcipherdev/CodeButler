import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanMemoryText, parseMemoryDirective, slugMemoryText, titleFromMemoryText } from "../memory/directives.js";
import type {
  CommitRecord,
  EvidenceRef,
  ExtractedMemory,
  ExtractorContext,
  ExtractorConversationInput,
  MemoryChunk,
  MemoryType,
  ProjectConfig
} from "../types.js";

export interface DeterministicMemoryExtraction {
  memories: ExtractedMemory[];
  promoteDedupeKeys: string[];
}

export interface DeterministicExtractionOptions {
  deterministic: ProjectConfig["deterministic"];
  repoPath?: string | undefined;
}

interface DirectiveMatch {
  type: MemoryType;
  text: string;
  typed: boolean;
  locator?: string | undefined;
}

export function extractDeterministicMemories(
  context: ExtractorContext,
  options: DeterministicExtractionOptions
): DeterministicMemoryExtraction {
  if (!options.deterministic.enabled) {
    return { memories: [], promoteDedupeKeys: [] };
  }

  const memories: ExtractedMemory[] = [];
  const promoteDedupeKeys = new Set<string>();

  if (options.deterministic.triggers.conversationDirectives) {
    for (const conversation of context.conversations) {
      for (const memory of extractConversationDirectiveMemories(conversation, options.deterministic.promoteStrongSignals)) {
        memories.push(memory.memory);
        if (memory.promote) promoteDedupeKeys.add(memory.memory.dedupeKey);
      }
    }
  }

  if (options.deterministic.triggers.gitChangedFiles) {
    for (const commit of context.commits) {
      for (const memory of extractGitChangedFileMemories(commit, options)) {
        memories.push(memory.memory);
        if (memory.promote) promoteDedupeKeys.add(memory.memory.dedupeKey);
      }
    }
  }

  const deduped = dedupeMemories(memories);
  if (options.deterministic.promoteStrongSignals) {
    for (const dedupeKey of findCorroboratedDedupeKeys(deduped)) {
      promoteDedupeKeys.add(dedupeKey);
    }
  }

  return {
    memories: deduped,
    promoteDedupeKeys: deduped
      .map((memory) => memory.dedupeKey)
      .filter((dedupeKey) => promoteDedupeKeys.has(dedupeKey))
  };
}

function extractConversationDirectiveMemories(
  conversation: ExtractorConversationInput,
  promoteStrongSignals: boolean
): Array<{ memory: ExtractedMemory; promote: boolean }> {
  const matches = findDirectiveMatches(conversation);
  return matches.map((match, index) => {
    const dedupeKey = `deterministic:conversation:${conversation.sourceId}:${index}`;
    const memory: ExtractedMemory = {
      type: match.type,
      title: titleFromText(match.text),
      summary: match.text,
      reason: "Captured from explicit conversation directive.",
      confidence: match.typed ? 1 : 0.75,
      evidence: [
        evidenceRef("conversation", conversation.sourceId, match.locator)
      ],
      relatedFiles: detectFileMentions(match.text),
      dedupeKey
    };
    return { memory, promote: promoteStrongSignals && match.typed };
  });
}

function findDirectiveMatches(conversation: ExtractorConversationInput): DirectiveMatch[] {
  const matches: DirectiveMatch[] = [];
  const chunks = conversation.chunks ?? [];
  if (chunks.length > 0) {
    for (const [fallbackIndex, chunk] of chunks.entries()) {
      if (!isUserChunk(chunk)) continue;
      const chunkIndex = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : fallbackIndex;
      const locator = `${conversation.sourceId}:chunk:${chunkIndex}`;
      for (const line of splitDirectiveLines(chunk.text)) {
        const match = parseDirective(line);
        if (match) matches.push({ ...match, locator });
      }
    }
    return matches;
  }

  for (const [index, line] of splitDirectiveLines(conversation.rawContent).entries()) {
    const match = parseDirective(line);
    if (match) matches.push({ ...match, locator: `line:${index}` });
  }
  return matches;
}

function isUserChunk(chunk: MemoryChunk): boolean {
  const role = chunk.metadata?.role;
  return typeof role !== "string" || role.toLowerCase() === "user" || role.toLowerCase() === "human";
}

function splitDirectiveLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:user|human):\s*/i, ""));
}

function parseDirective(line: string): Omit<DirectiveMatch, "locator"> | undefined {
  return parseMemoryDirective(line);
}

function extractGitChangedFileMemories(
  commit: CommitRecord,
  options: DeterministicExtractionOptions
): Array<{ memory: ExtractedMemory; promote: boolean }> {
  const memories: Array<{ memory: ExtractedMemory; promote: boolean }> = [];
  const triggers = options.deterministic.triggers;
  for (const changedFile of commit.changedFiles.map(normalizeFilePath)) {
    if (triggers.decisionFiles && isDecisionFile(changedFile)) {
      const decision = readDecisionFileMemory(commit, changedFile, options.repoPath);
      if (decision) memories.push({ memory: decision, promote: options.deterministic.promoteStrongSignals });
      continue;
    }

    if (triggers.testExpectations && isTestFile(changedFile)) {
      for (const memory of extractTestExpectationMemories(commit, changedFile)) {
        memories.push({ memory, promote: false });
      }
      continue;
    }

    if (triggers.packageAndConfigFacts && isPackageOrConfigFile(changedFile)) {
      for (const memory of extractConfigFactMemories(commit, changedFile)) {
        memories.push({ memory, promote: false });
      }
      continue;
    }

    if (triggers.docsFacts && isDocsFactFile(changedFile)) {
      for (const memory of extractDocsFactMemories(commit, changedFile)) {
        memories.push({ memory, promote: false });
      }
    }
  }
  return memories;
}

function readDecisionFileMemory(
  commit: CommitRecord,
  filePath: string,
  repoPath: string | undefined
): ExtractedMemory | undefined {
  if (!repoPath) return undefined;
  const raw = readRepoFile(repoPath, filePath);
  if (!raw) return undefined;

  const title = parseMarkdownTitle(raw);
  const decision = parseField(raw, "Decision");
  const reason = parseField(raw, "Reason");
  if (!title || !decision || !reason) return undefined;

  return {
    type: "decision",
    title,
    summary: decision,
    reason,
    confidence: 1,
    evidence: [evidenceRef("commit", commit.hash, filePath)],
    relatedFiles: [filePath],
    dedupeKey: `deterministic:decision-file:${filePath}:${slug(title)}`
  };
}

function extractTestExpectationMemories(commit: CommitRecord, filePath: string): ExtractedMemory[] {
  const fileDiff = extractDiffForFile(commit.diffSummary, filePath);
  const names = new Set<string>();
  for (const line of addedLines(fileDiff)) {
    for (const match of line.matchAll(/\b(?:it|test)\s*\(\s*["'`](.+?)["'`]/g)) {
      if (match[1]) names.add(cleanSentence(match[1]));
    }
  }

  return [...names].map((name) => ({
    type: "constraint",
    title: titleFromText(name),
    summary: `Test expectation: ${name}`,
    reason: "Captured from deterministic test expectation in a changed test file.",
    confidence: 0.7,
    evidence: [evidenceRef("commit", commit.hash, filePath)],
    relatedFiles: [filePath],
    dedupeKey: `deterministic:test:${filePath}:${slug(name)}`
  }));
}

function extractConfigFactMemories(commit: CommitRecord, filePath: string): ExtractedMemory[] {
  const fields = new Set<string>();
  for (const line of addedLines(extractDiffForFile(commit.diffSummary, filePath))) {
    const match = line.match(/"([^"]+)"\s*:/);
    if (match?.[1]) fields.add(match[1]);
  }
  return [...fields].slice(0, 20).map((field) => ({
    type: "constraint",
    title: `Config defines ${field}`,
    summary: `${filePath} defines ${field}.`,
    reason: "Captured from deterministic package or config file change.",
    confidence: 0.65,
    evidence: [evidenceRef("commit", commit.hash, filePath)],
    relatedFiles: [filePath],
    dedupeKey: `deterministic:config:${filePath}:${slug(field)}`
  }));
}

function extractDocsFactMemories(commit: CommitRecord, filePath: string): ExtractedMemory[] {
  const headings = new Set<string>();
  for (const line of addedLines(extractDiffForFile(commit.diffSummary, filePath))) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match?.[1]) headings.add(cleanSentence(match[1]));
  }
  return [...headings].slice(0, 10).map((heading) => ({
    type: "constraint",
    title: titleFromText(heading),
    summary: `Documentation includes ${heading}.`,
    reason: "Captured from deterministic documentation change.",
    confidence: 0.6,
    evidence: [evidenceRef("commit", commit.hash, filePath)],
    relatedFiles: [filePath],
    dedupeKey: `deterministic:docs:${filePath}:${slug(heading)}`
  }));
}

function readRepoFile(repoPath: string, filePath: string): string | undefined {
  try {
    return readFileSync(join(repoPath, filePath), "utf8");
  } catch {
    return undefined;
  }
}

function isDecisionFile(filePath: string): boolean {
  return /^(docs\/(decisions|adr)\/|adr\/).+\.md$/i.test(filePath);
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(tests?\/.+|.+\.(test|spec))\.[cm]?[jt]sx?$/i.test(filePath);
}

function isPackageOrConfigFile(filePath: string): boolean {
  return filePath === "package.json" || filePath === "tsconfig.json" || filePath === ".code-butler/config.json";
}

function isDocsFactFile(filePath: string): boolean {
  return (filePath === "README.md" || /^docs\/.+\.md$/i.test(filePath)) && !isDecisionFile(filePath);
}

function extractDiffForFile(diffSummary: string, filePath: string): string {
  const sections = diffSummary.split(/^diff --git /m);
  const section = sections.find((candidate) => candidate.includes(` a/${filePath} b/${filePath}`));
  return section ?? diffSummary;
}

function addedLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function parseMarkdownTitle(raw: string): string | undefined {
  const match = raw.match(/^#\s*Decision:\s*(.+)$/im) ?? raw.match(/^#\s*(.+)$/im);
  return match?.[1]?.trim();
}

function parseField(raw: string, field: string): string | undefined {
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function evidenceRef(sourceType: EvidenceRef["sourceType"], sourceId: string, locator?: string): EvidenceRef {
  return locator ? { sourceType, sourceId, locator } : { sourceType, sourceId };
}

function detectFileMentions(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(matches.map(normalizeFilePath))];
}

function dedupeMemories(memories: ExtractedMemory[]): ExtractedMemory[] {
  const byKey = new Map<string, ExtractedMemory>();
  for (const memory of memories) {
    if (!byKey.has(memory.dedupeKey)) byKey.set(memory.dedupeKey, memory);
  }
  return [...byKey.values()];
}

function findCorroboratedDedupeKeys(memories: ExtractedMemory[]): string[] {
  const groups = new Map<string, ExtractedMemory[]>();
  for (const memory of memories) {
    if (memory.confidence >= 1) continue;
    const key = `${memory.type}:${normalizeSignal(memory.title)}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .flatMap((group) => group.map((memory) => memory.dedupeKey));
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function cleanSentence(value: string): string {
  return cleanMemoryText(value);
}

function titleFromText(value: string): string {
  return titleFromMemoryText(value);
}

function slug(value: string): string {
  return slugMemoryText(value);
}
