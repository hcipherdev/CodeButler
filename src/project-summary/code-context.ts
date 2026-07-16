import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { redactSensitiveText } from "../privacy/redaction.js";

export const MAX_PROJECT_SUMMARY_CODE_FILES = 12;
export const MAX_PROJECT_SUMMARY_FILE_CHARS = 20_000;
export const MAX_PROJECT_SUMMARY_CODE_CHARS = 120_000;
const MAX_PROJECT_SUMMARY_ANALYSIS_CHARS = 120_000;
const PROJECT_SUMMARY_READ_CHUNK_BYTES = 64 * 1024;
const PROJECT_SUMMARY_SECRET_OVERLAP_CHARS = 64 * 1024;

const EXCLUDED_DIRECTORY_KINDS = new Set([
  "build",
  "cache",
  "code-butler",
  "coverage",
  "dependencies",
  "deps",
  "dist",
  "gen",
  "generated",
  "next",
  "node-modules",
  "out",
  "pycache",
  "site-packages",
  "target",
  "third-party",
  "turbo",
  "vendor",
  "venv"
]);
const AGENT_INSTRUCTION_PATHS = new Set(["AGENTS.md", "CLAUDE.md"]);
const CREDENTIAL_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
  "auth.json",
  "credentials.json",
  "nuget.config",
  "pip.conf",
  "pip.ini"
]);
const CREDENTIAL_STORE_PATH_PAIRS = new Set([
  ".aws/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".docker/config.json",
  ".kube/config"
]);
const SENSITIVE_EXTENSIONS = new Set([".cer", ".crt", ".der", ".key", ".p12", ".pfx", ".pem"]);
const BINARY_EXTENSIONS = new Set([
  ".a",
  ".avi",
  ".bin",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".sqlite",
  ".tar",
  ".ttf",
  ".wasm",
  ".woff",
  ".woff2",
  ".zip"
]);
const SOURCE_CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx"
]);
const BINARY_SAMPLE_BYTES = 8 * 1024;
const BINARY_SIGNATURES = [
  Buffer.from("%PDF-", "ascii"),
  Buffer.from("GIF87a", "ascii"),
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe])
] as const;

export type ProjectSummaryCodeSelectionReason =
  | "manifest-entrypoint"
  | "promoted-memory"
  | "recent-commit";

export interface ProjectSummaryCodeFile {
  path: string;
  content: string;
  contentHash: string;
  originalBytes: number;
  truncated: boolean;
  selectionReason: ProjectSummaryCodeSelectionReason;
}

export type ProjectSummaryTrackedTextFile = Omit<ProjectSummaryCodeFile, "selectionReason">;

export interface ProjectSummaryCodeFileInput {
  manifests: Array<{ path: string; content: string }>;
  memories: Array<{ relatedFiles: string[] }>;
  commits: Array<{ changedFiles: string[] }>;
}

export interface ProjectSummaryReadOptions {
  beforeOpen?: (absolutePath: string) => void;
}

export function collectProjectSummaryCodeFiles(
  rootDir: string,
  input: ProjectSummaryCodeFileInput
): ProjectSummaryCodeFile[] {
  const trackedPaths = readTrackedPaths(rootDir);
  const candidates = new Map<string, ProjectSummaryCodeSelectionReason>();

  for (const path of manifestEntrypoints(rootDir, input.manifests, trackedPaths)) {
    addCandidate(candidates, path, "manifest-entrypoint", trackedPaths);
  }
  for (const memory of input.memories) {
    for (const path of memory.relatedFiles) addCandidate(candidates, path, "promoted-memory", trackedPaths);
  }
  for (const commit of input.commits) {
    for (const path of commit.changedFiles) addCandidate(candidates, path, "recent-commit", trackedPaths);
  }

  const orderedCandidates = [...candidates]
    .sort(([leftPath, leftReason], [rightPath, rightReason]) => {
      const priority = selectionPriority(leftReason) - selectionPriority(rightReason);
      return priority || compareNormalizedPaths(leftPath, rightPath);
    });
  const selected: ProjectSummaryCodeFile[] = [];
  let transmittedChars = 0;
  for (const [path, selectionReason] of orderedCandidates) {
    if (
      selected.length >= MAX_PROJECT_SUMMARY_CODE_FILES ||
      transmittedChars >= MAX_PROJECT_SUMMARY_CODE_CHARS
    ) {
      break;
    }
    const remainingChars = MAX_PROJECT_SUMMARY_CODE_CHARS - transmittedChars;
    const file = readProjectSummaryTrackedFile(
      rootDir,
      path,
      trackedPaths,
      Math.min(MAX_PROJECT_SUMMARY_FILE_CHARS, remainingChars)
    );
    if (!file) continue;
    selected.push({ ...file, selectionReason });
    transmittedChars += file.content.length;
  }
  return selected;
}

export function readTrackedPaths(rootDir: string): ReadonlySet<string> {
  try {
    const output = execFileSync("git", ["-C", rootDir, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const trackedPaths = output
      .split("\0")
      .filter(Boolean)
      .map((path) => normalizeTrackedPath(path))
      .filter((path): path is string => path !== undefined);
    const ignoredPaths = readIgnoredPaths(rootDir, trackedPaths);
    if (!ignoredPaths) return new Set();
    return new Set(trackedPaths.filter((path) => !ignoredPaths.has(path)));
  } catch {
    return new Set();
  }
}

export function readProjectSummaryTrackedFile(
  rootDir: string,
  rawPath: string,
  trackedPaths: ReadonlySet<string> = readTrackedPaths(rootDir),
  maxChars = MAX_PROJECT_SUMMARY_FILE_CHARS,
  options: ProjectSummaryReadOptions = {}
): ProjectSummaryTrackedTextFile | undefined {
  const path = normalizeTrackedPath(rawPath);
  if (!path || !trackedPaths.has(path) || isExcludedPath(path)) return undefined;

  try {
    const rootRealPath = realpathSync(rootDir);
    const pathSegments = path.split("/");
    const absolutePath = resolve(rootRealPath, ...pathSegments);
    if (!isInsideRepository(rootRealPath, absolutePath)) return undefined;

    let walkedPath = rootRealPath;
    for (const segment of pathSegments) {
      walkedPath = resolve(walkedPath, segment);
      const stats = lstatSync(walkedPath);
      if (stats.isSymbolicLink()) return undefined;
    }
    const preOpenStats = lstatSync(absolutePath);
    if (!preOpenStats.isFile() || preOpenStats.isSymbolicLink()) return undefined;
    if (!isInsideRepository(rootRealPath, realpathSync(absolutePath))) return undefined;
    if (!isInsideRepository(rootRealPath, realpathSync(resolve(absolutePath, "..")))) return undefined;

    options.beforeOpen?.(absolutePath);
    const noFollowFlag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const descriptor = openSync(absolutePath, fsConstants.O_RDONLY | noFollowFlag);
    try {
      const openedStats = fstatSync(descriptor);
      if (
        !openedStats.isFile() ||
        openedStats.dev !== preOpenStats.dev ||
        openedStats.ino !== preOpenStats.ino
      ) {
        return undefined;
      }
      return scanProjectSummaryDescriptor(path, descriptor, maxChars);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

function scanProjectSummaryDescriptor(
  path: string,
  descriptor: number,
  maxChars: number
): ProjectSummaryTrackedTextFile | undefined {
  const retainedLimit = Math.min(
    MAX_PROJECT_SUMMARY_ANALYSIS_CHARS,
    Math.max(0, Number.isFinite(maxChars) ? Math.floor(maxChars) : 0)
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(PROJECT_SUMMARY_READ_CHUNK_BYTES);
  const binarySample = Buffer.allocUnsafe(BINARY_SAMPLE_BYTES);
  let binarySampleLength = 0;
  let originalBytes = 0;
  let totalChars = 0;
  let content = "";
  let secretOverlap = "";

  const processText = (decoded: string): boolean => {
    totalChars += decoded.length;
    if (content.length < retainedLimit) {
      content += decoded.slice(0, retainedLimit - content.length);
    }
    const secretWindow = `${secretOverlap}${decoded}`;
    if (hasSensitiveContent(path, secretWindow)) return false;
    secretOverlap = secretWindow.slice(-PROJECT_SUMMARY_SECRET_OVERLAP_CHARS);
    return true;
  };

  while (true) {
    const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    originalBytes += bytesRead;
    hash.update(bytes);
    if (bytes.includes(0)) return undefined;
    if (binarySampleLength < BINARY_SAMPLE_BYTES) {
      const sampleBytes = Math.min(bytesRead, BINARY_SAMPLE_BYTES - binarySampleLength);
      bytes.copy(binarySample, binarySampleLength, 0, sampleBytes);
      binarySampleLength += sampleBytes;
    }
    if (!processText(decoder.decode(bytes, { stream: true }))) return undefined;
  }
  if (!processText(decoder.decode())) return undefined;
  if (isBinarySample(binarySample.subarray(0, binarySampleLength))) return undefined;
  return {
    path,
    content,
    contentHash: hash.digest("hex"),
    originalBytes,
    truncated: content.length < totalChars
  };
}

export function listProjectSummarySafeTrackedPaths(
  rootDir: string,
  trackedPaths: ReadonlySet<string> = readTrackedPaths(rootDir),
  limit = Number.MAX_SAFE_INTEGER,
  options: ProjectSummaryReadOptions = {}
): string[] {
  const inventory: string[] = [];
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  for (const path of [...trackedPaths].sort(compareNormalizedPaths)) {
    if (inventory.length >= boundedLimit) break;
    if (readProjectSummaryTrackedFile(rootDir, path, trackedPaths, 0, options)) inventory.push(path);
  }
  return inventory;
}

function addCandidate(
  candidates: Map<string, ProjectSummaryCodeSelectionReason>,
  rawPath: string,
  reason: ProjectSummaryCodeSelectionReason,
  trackedPaths: ReadonlySet<string>
): void {
  const path = normalizeTrackedPath(rawPath);
  if (
    !path ||
    AGENT_INSTRUCTION_PATHS.has(path) ||
    !trackedPaths.has(path) ||
    candidates.has(path)
  ) {
    return;
  }
  candidates.set(path, reason);
}

function manifestEntrypoints(
  rootDir: string,
  manifests: Array<{ path: string; content: string }>,
  trackedPaths: ReadonlySet<string>
): string[] {
  const entrypoints = new Set<string>();
  for (const manifest of [...manifests].sort((left, right) => compareNormalizedPaths(left.path, right.path))) {
    const manifestPath = normalizeTrackedPath(manifest.path);
    if (!manifestPath || !trackedPaths.has(manifestPath)) continue;
    const manifestFile = readProjectSummaryTrackedFile(
      rootDir,
      manifestPath,
      trackedPaths,
      Number.MAX_SAFE_INTEGER
    );
    if (!manifestFile) continue;
    const content = manifestFile.content;
    const baseDir = posix.dirname(manifestPath);
    const baseName = posix.basename(manifestPath).toLowerCase();
    if (baseName === "package.json") {
      for (const path of packageEntrypoints(content)) addResolved(entrypoints, baseDir, path, trackedPaths);
    } else if (baseName === "cargo.toml") {
      addResolved(entrypoints, baseDir, "src/main.rs", trackedPaths);
      addResolved(entrypoints, baseDir, "src/lib.rs", trackedPaths);
      for (const path of cargoBinEntrypoints(content)) addResolved(entrypoints, baseDir, path, trackedPaths);
    } else if (baseName === "pyproject.toml") {
      for (const path of pythonEntrypoints(content)) addResolved(entrypoints, baseDir, path, trackedPaths);
    } else if (baseName === "go.mod") {
      addResolved(entrypoints, baseDir, "main.go", trackedPaths);
      const prefix = baseDir === "." ? "cmd/" : `${baseDir}/cmd/`;
      for (const path of trackedPaths) {
        if (path.startsWith(prefix) && path.endsWith("/main.go")) entrypoints.add(path);
      }
    }
  }
  return [...entrypoints];
}

function packageEntrypoints(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const values: string[] = [];
    for (const key of ["main", "module"]) {
      if (typeof parsed[key] === "string") values.push(parsed[key]);
    }
    collectStringValues(parsed.browser, values);
    collectStringValues(parsed.bin, values);
    collectStringValues(parsed.exports, values);
    return values;
  } catch {
    return [];
  }
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) collectStringValues(child, output);
}

function cargoBinEntrypoints(content: string): string[] {
  const paths: string[] = [];
  let inBin = false;
  for (const line of content.split(/\r?\n/)) {
    const table = line.trim().match(/^\[\[(.+)\]\]$/)?.[1]?.trim();
    if (table !== undefined) {
      inBin = table === "bin";
      continue;
    }
    if (!inBin) continue;
    const path = line.match(/^\s*path\s*=\s*["']([^"']+)["']/)?.[1];
    if (path) paths.push(path);
  }
  return paths;
}

function pythonEntrypoints(content: string): string[] {
  const paths: string[] = [];
  let section = "";
  for (const line of content.split(/\r?\n/)) {
    const table = line.trim().match(/^\[([^\]]+)\]$/)?.[1]?.trim().toLowerCase();
    if (table !== undefined) {
      section = table;
      continue;
    }
    if (section === "project.scripts" || section === "tool.poetry.scripts") {
      const module = line.match(/^\s*[^#=]+\s*=\s*["']([A-Za-z_][\w.]*)\s*(?::[^"']+)?["']/)?.[1];
      if (module) paths.push(`${module.replaceAll(".", "/")}.py`);
    }
    if (section === "tool.setuptools") {
      const modules = line.match(/^\s*py-modules\s*=\s*\[([^\]]*)\]/)?.[1];
      if (modules) {
        for (const match of modules.matchAll(/["']([A-Za-z_][\w.]*)["']/g)) {
          if (match[1]) paths.push(`${match[1].replaceAll(".", "/")}.py`);
        }
      }
    }
  }
  return paths;
}

function addResolved(
  output: Set<string>,
  baseDir: string,
  rawPath: string,
  trackedPaths: ReadonlySet<string>
): void {
  if (rawPath.startsWith("/")) return;
  const path = normalizeTrackedPath(posix.join(baseDir, rawPath));
  if (path && trackedPaths.has(path)) output.add(path);
}

function normalizeTrackedPath(rawPath: string): string | undefined {
  const platformPath = sep === "\\" ? rawPath.replaceAll("\\", "/") : rawPath;
  const slashPath = platformPath.replace(/^\.\//, "");
  if (!slashPath || slashPath.startsWith("/")) return undefined;
  const normalized = posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function selectionPriority(reason: ProjectSummaryCodeSelectionReason): number {
  if (reason === "manifest-entrypoint") return 0;
  if (reason === "promoted-memory") return 1;
  return 2;
}

function compareNormalizedPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (
    segments
      .slice(0, -1)
      .some((segment) => isExcludedDirectorySegment(segment) || isSensitiveDirectoryName(segment))
  ) {
    return true;
  }
  if (lowerSegments.some((segment) => segment.startsWith(".env"))) return true;
  if (hasCredentialStorePathPair(lowerSegments)) return true;
  const basename = lowerSegments.at(-1) ?? "";
  if (CREDENTIAL_BASENAMES.has(basename)) return true;
  const extensionIndex = basename.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? basename.slice(extensionIndex) : "";
  if (SENSITIVE_EXTENSIONS.has(extension) || BINARY_EXTENSIONS.has(extension)) return true;
  if (isSensitiveConfigBasename(basename)) return true;
  if (isSensitiveKeyBasename(basename)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(basename)) return true;
  return false;
}

function hasCredentialStorePathPair(segments: string[]): boolean {
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (CREDENTIAL_STORE_PATH_PAIRS.has(`${segments[index]}/${segments[index + 1]}`)) return true;
  }
  return false;
}

function isSensitiveConfigBasename(basename: string): boolean {
  const extension = posix.extname(basename).toLowerCase();
  if (SOURCE_CODE_EXTENSIONS.has(extension)) return false;
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  return /^(?:credentials?|secrets?)$/.test(stem);
}

function isSensitiveDirectoryName(name: string): boolean {
  return /(?:^|[._-])(credentials?|secrets?|private[._-]?key|api[._-]?key|deploy[._-]?keys?|keys?|certificates?|certs?)(?:[._-]|$)/.test(
    name.toLowerCase()
  );
}

function isSensitiveKeyBasename(basename: string): boolean {
  if (/^keys?$/.test(basename)) return true;
  const stem = basename.replace(/\.[^.]+$/, "");
  return /^(?:private|deploy)[._-]?keys?$/.test(stem);
}

function isExcludedDirectorySegment(segment: string): boolean {
  return EXCLUDED_DIRECTORY_KINDS.has(normalizeSegmentKind(segment));
}

function normalizeSegmentKind(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]+/g, "-");
}

function hasSensitiveContent(path: string, content: string): boolean {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) return true;
  const redactions = redactSensitiveText(content).redactions;
  if (redactions.some(({ type }) => type === "private_key" || type === "credential_url")) {
    return true;
  }
  if (/\b(?:sk-(?:proj-|ant-api\d*-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(content)) {
    return true;
  }
  for (const match of content.matchAll(/\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi)) {
    if (!isCredentialPlaceholder(match[1] ?? "")) return true;
  }
  for (const line of content.split(/\r?\n/)) {
    for (const match of line.matchAll(
      /(?:^|[{,;])\s*-?\s*(?:(?:export\s+)?(?:const|let|var)\s+)?(?:[A-Za-z_][\w-]*\.)*["']?(?:aws[_-]?secret[_-]?access[_-]?key|api[_-]?key|_?auth(?:entication)?[_-]?token|password|passwd|client[_-]?secret|access[_-]?(?:token|key)|private[_-]?key|token|auth|secret)["']?\s*(?:=|:)\s*(\$\{[^}]+\}|["'][^"']*["']|[^,;}]+)/gi
    )) {
      if (isMaterialCredentialValue(path, match[1] ?? "")) return true;
    }
  }
  return false;
}

function isMaterialCredentialValue(path: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (!value || isCredentialPlaceholder(value)) return false;
  const quoted = value.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) return !isCredentialPlaceholder(quoted[2] ?? "");
  if (/^["']/.test(value)) return true;
  if (/^\$\{/.test(value) && !value.includes("}")) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]+|\[[^\]\r\n]+\])+$/.test(value)) return false;
  if (
    SOURCE_CODE_EXTENSIONS.has(posix.extname(path).toLowerCase()) &&
    (/^[A-Za-z_$][\w$]*$/.test(value) ||
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(value))
  ) {
    return false;
  }
  return true;
}

function isCredentialPlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return /^(?:\$\{[^}]+\}|\{\{[^}]+\}\}|<[^>]+>|\[(?:redacted|hidden|secret|token|password)\]|(?:your|example|sample|placeholder|changeme)[_-].+|redacted|placeholder|changeme|null|none|undefined)$/i.test(
    normalized
  );
}

function readIgnoredPaths(rootDir: string, trackedPaths: string[]): ReadonlySet<string> | undefined {
  if (trackedPaths.length === 0) return new Set();
  const batched = runCheckIgnore(rootDir, trackedPaths);
  if (batched) return batched;

  const ignoredPaths = new Set<string>();
  for (const path of trackedPaths) {
    const checked = runCheckIgnore(rootDir, [path]);
    if (!checked) {
      ignoredPaths.add(path);
      continue;
    }
    for (const ignoredPath of checked) ignoredPaths.add(ignoredPath);
  }
  return ignoredPaths;
}

function runCheckIgnore(rootDir: string, paths: string[]): ReadonlySet<string> | undefined {
  const result = spawnSync(
    "git",
    ["-C", rootDir, "check-ignore", "--no-index", "-z", "--stdin"],
    {
      encoding: "utf8",
      input: `${paths.join("\0")}\0`,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"]
    }
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
  return new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => normalizeTrackedPath(path))
      .filter((path): path is string => path !== undefined)
  );
}

function isBinarySample(sample: Uint8Array): boolean {
  if (BINARY_SIGNATURES.some((signature) => sampleStartsWith(sample, signature))) return true;
  if (isBinaryNetpbm(sample)) return true;
  return sample.some(
    (byte) => byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
  );
}

function isBinaryNetpbm(sample: Uint8Array): boolean {
  return (
    sample[0] === 0x50 &&
    (sample[1] === 0x34 || sample[1] === 0x35 || sample[1] === 0x36) &&
    sample[2] !== undefined &&
    (sample[2] === 0x09 || sample[2] === 0x0a || sample[2] === 0x0d || sample[2] === 0x20)
  );
}

function sampleStartsWith(sample: Uint8Array, signature: Uint8Array): boolean {
  if (sample.length < signature.length) return false;
  return signature.every((byte, index) => sample[index] === byte);
}

function isInsideRepository(rootRealPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootRealPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}
