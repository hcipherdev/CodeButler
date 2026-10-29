import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

import { gitExecutable } from "../git-executable.js";
import { cachedRead } from "../retrieval/read-cache.js";
import type { MemoryStore } from "../storage/store.js";
import type { CommitRecord, MemoryStatement } from "../types.js";

/**
 * Decides whether a commit that touched a memory's related file changed anything the
 * memory talks about. A memory names concrete anchors (quoted text, identifiers, routes,
 * versions); a commit whose changed lines contain none of them leaves the memory as it
 * was, so it needs no review. The inputs are synced memory text and commit diffs, read
 * from the local repository when the stored diff is cut off; a device without the
 * commit treats the change as relevant, which only costs it a review.
 */

export interface Anchor {
  value: string;
  /** Quoted prose is matched ignoring case; identifiers are matched exactly. */
  caseless: boolean;
}

export interface AnchorSource {
  title: string;
  summary: string;
  reason?: string | undefined;
  statement?: MemoryStatement | undefined;
  relatedFiles: string[];
}

export interface FileDiffSection {
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  /** The section as stored, starting at its `diff --git` header line. */
  text: string;
  /** Added and removed lines only, without their +/- markers. */
  changedText: string;
  /** Changed line ranges on the new side, 1-based and inclusive. */
  newRanges: Array<[number, number]>;
  truncated: boolean;
}

const MAX_ANCHORS = 24;
const TRUNCATION_MARKER = /\n\[diff truncated at \d+ chars\]\s*$/;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "when", "then", "than", "true", "false",
  "null", "undefined", "none", "todo", "e.g", "i.e", "etc"
]);

export function memoryAnchors(memory: AnchorSource): Anchor[] {
  const text = [
    memory.title,
    memory.summary,
    memory.reason ?? "",
    memory.statement?.text ?? "",
    ...Object.values(memory.statement?.fields ?? {}).filter((value): value is string => typeof value === "string")
  ].join("\n");
  const excluded = new Set(memory.relatedFiles.flatMap((filePath) => {
    const base = filePath.split("/").pop() ?? filePath;
    return [filePath, base, base.replace(/\.[^.]+$/, "")];
  }));
  const anchors = new Map<string, Anchor>();
  const add = (raw: string, caseless: boolean) => {
    const value = raw.trim().replace(/\s+/g, " ");
    if (value.length < (caseless ? 3 : 4) || excluded.has(value) || STOPWORDS.has(value.toLowerCase())) return;
    const key = value.toLowerCase();
    if (!anchors.has(key)) anchors.set(key, { value: caseless ? key : value, caseless });
  };
  for (const match of text.matchAll(/`([^`\n]{2,80}?)`/g)) add(match[1]!, false);
  for (const match of text.matchAll(/["“]([^"“”\n]{2,80}?)["”]/g)) add(match[1]!, true);
  for (const match of text.matchAll(/(?<![\w])'([^'\n]{2,80}?)'(?![\w])/g)) add(match[1]!, true);
  for (const match of text.matchAll(/(?<![\w.\/])\/[a-z0-9][\w\-./]*\w/gi)) add(match[0], false);
  for (const match of text.matchAll(/\bv?\d+\.\d+(?:\.\d+)*\b/g)) add(match[0], false);
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*(?:[.\-][A-Za-z_$][\w$]*)*/g)) {
    if (isCodeLike(match[0])) add(match[0], false);
  }
  return [...anchors.values()].slice(0, MAX_ANCHORS);
}

function isCodeLike(token: string): boolean {
  if (token.includes("_")) return true;
  if (/[a-z][A-Z]/.test(token)) return true;
  if (/^[\w$]+(\.[\w$]+)+$/.test(token)) return true;
  return (token.match(/-/g)?.length ?? 0) >= 2;
}

export function anchorsIn(text: string, anchors: Anchor[]): Anchor[] {
  const lower = anchors.some((anchor) => anchor.caseless) ? text.toLowerCase().replace(/\s+/g, " ") : "";
  return anchors.filter((anchor) => anchor.caseless ? lower.includes(anchor.value) : text.includes(anchor.value));
}

/** The part of a stored commit diff that belongs to one file, or undefined when it is absent. */
export function fileDiffSection(diffSummary: string, filePath: string): FileDiffSection | undefined {
  const truncatedDiff = TRUNCATION_MARKER.test(diffSummary);
  const sections = diffSummary.split(/^diff --git /m).slice(1);
  const index = sections.findIndex((section) => {
    const header = section.slice(0, section.indexOf("\n") >>> 0);
    return header === `a/${filePath} b/${filePath}` || header.startsWith(`a/${filePath} b/`) || header.endsWith(` b/${filePath}`);
  });
  if (index < 0) return undefined;
  const raw = sections[index]!;
  const lines = raw.split(/\r?\n/);
  const meta = lines.slice(0, lines.findIndex((line) => line.startsWith("@@")) >>> 0).join("\n");
  const status: FileDiffSection["status"] = /^deleted file mode/m.test(meta) ? "deleted"
    : /^rename from /m.test(meta) ? "renamed"
    : /^Binary files /m.test(raw) ? "binary"
    : /^new file mode/m.test(meta) ? "added"
    : "modified";
  const changed: string[] = [];
  const newRanges: Array<[number, number]> = [];
  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      const start = Number(hunk[1]);
      newRanges.push([start, start + Math.max(Number(hunk[2] ?? "1"), 1) - 1]);
    } else if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      changed.push(line.slice(1));
    }
  }
  return {
    status,
    text: `diff --git ${raw.replace(TRUNCATION_MARKER, "")}`,
    changedText: changed.join("\n"),
    newRanges,
    truncated: truncatedDiff && index === sections.length - 1
  };
}

/** Hunks with their stored wide context narrowed to a few lines around each change. */
export function compactHunks(sectionText: string, context = 5): string {
  const lines = sectionText.split(/\r?\n/);
  const keep = new Array<boolean>(lines.length).fill(false);
  let inHunk = false;
  lines.forEach((line, index) => {
    if (line.startsWith("@@")) { inHunk = true; keep[index] = true; return; }
    if (!inHunk) { keep[index] = true; return; }
    if (/^[+-]/.test(line)) {
      for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at += 1) {
        if (!lines[at]!.startsWith("@@")) keep[at] = true;
      }
      keep[index] = true;
    }
  });
  const out: string[] = [];
  let gap = false;
  lines.forEach((line, index) => {
    if (keep[index]) { out.push(line); gap = false; }
    else if (!gap) { out.push(" …"); gap = true; }
  });
  return out.join("\n");
}

/** Whether a commit's change to one file can affect a memory with these anchors. */
export function isRelevantChange(store: MemoryStore, commit: CommitRecord, filePath: string, anchors: Anchor[]): boolean {
  const section = cachedFileDiffSection(store, commit, filePath);
  // An unreadable, deleted, renamed or binary change, or a memory with nothing concrete
  // to look for, is left to a reviewer.
  if (!section || section.truncated || (section.status !== "modified" && section.status !== "added")) return true;
  if (anchors.length === 0) return true;
  return anchorsIn(section.changedText, anchors).length > 0;
}

/**
 * The stored section when it is complete; otherwise the same change read from the local
 * repository. Stored diffs are bounded across all of a commit's files, so a file late in a
 * large commit is often cut off or absent.
 */
export function cachedFileDiffSection(store: MemoryStore, commit: CommitRecord, filePath: string): FileDiffSection | undefined {
  return cachedRead(store, `diff-section:${commit.hash}\0${filePath}`, () => {
    const stored = fileDiffSection(commit.diffSummary, filePath);
    if (stored && !stored.truncated) return stored;
    return repositorySection(store, commit.hash, filePath) ?? stored;
  });
}

const MAX_REPOSITORY_SECTIONS = 20_000;
/** Commits never change, so a section read once serves the whole process. */
const repositorySections = new Map<string, FileDiffSection | null>();

function repositorySection(store: MemoryStore, hash: string, filePath: string): FileDiffSection | undefined {
  const root = store.paths.rootDir;
  const repo = basename(root) === ".code-butler" ? dirname(root) : root;
  const key = (commitHash: string) => `${repo}\0${commitHash}\0${filePath}`;
  if (!repositorySections.has(key(hash))) {
    // One git call reads this file's change in every indexed commit that may need it.
    const hashes = [...new Set([hash, ...fileCommits(store, filePath).map((commit) => commit.hash)])]
      .filter((commitHash) => !repositorySections.has(key(commitHash)));
    if (repositorySections.size + hashes.length > MAX_REPOSITORY_SECTIONS) repositorySections.clear();
    readRepositorySections(repo, filePath, hashes, (commitHash, section) => repositorySections.set(key(commitHash), section));
  }
  return repositorySections.get(key(hash)) ?? undefined;
}

function readRepositorySections(
  repo: string,
  filePath: string,
  hashes: string[],
  save: (hash: string, section: FileDiffSection | null) => void
): void {
  let output: string;
  try {
    output = execFileSync(gitExecutable(), [
      "show", "--format=%x01%H", "--no-ext-diff", "--no-color", "--unified=5", ...hashes, "--", `:(literal)${filePath}`
    ], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    // One unknown commit fails the whole call; read the rest one by one.
    if (hashes.length > 1) for (const hash of hashes) readRepositorySections(repo, filePath, [hash], save);
    else if (hashes[0]) save(hashes[0], null);
    return;
  }
  const seen = new Set<string>();
  for (const chunk of output.split("\u0001").slice(1)) {
    const newline = chunk.indexOf("\n");
    const hash = (newline < 0 ? chunk : chunk.slice(0, newline)).trim();
    seen.add(hash);
    save(hash, newline < 0 ? null : fileDiffSection(chunk.slice(newline + 1), filePath) ?? null);
  }
  for (const hash of hashes) if (!seen.has(hash)) save(hash, null);
}

/** Indexed commits that touched a file, newest first. */
export function fileCommits(store: MemoryStore, filePath: string): CommitRecord[] {
  return cachedRead(store, `file-commits-desc:${filePath}`, () => store.findCommits({ filePath, limit: 100 })
    .sort((left, right) => right.authoredAt.localeCompare(left.authoredAt) || right.hash.localeCompare(left.hash)));
}

/** The newest commit to a file that could have changed what the memory says. */
export function latestRelevantCommit(store: MemoryStore, memory: AnchorSource, filePath: string): CommitRecord | undefined {
  const anchors = memoryAnchors(memory);
  return cachedRead(store, `latest-relevant:${filePath}\0${JSON.stringify(anchors)}`, () =>
    fileCommits(store, filePath).find((commit) => isRelevantChange(store, commit, filePath, anchors)));
}

/** Relevant commits to a file authored after a time, newest first. */
export function relevantCommitsAfter(store: MemoryStore, memory: AnchorSource, filePath: string, after: number): CommitRecord[] {
  const anchors = memoryAnchors(memory);
  return fileCommits(store, filePath).filter((commit) => {
    const authoredAt = Date.parse(commit.authoredAt);
    return Number.isFinite(authoredAt) && authoredAt > after && isRelevantChange(store, commit, filePath, anchors);
  });
}
