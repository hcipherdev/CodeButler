import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { MODEL_FIELDS } from "./ai/models.js";
import { canonicalCheckoutRoot } from "./cloud/checkout-path.js";
import { globalConfigDir } from "./config.js";

/**
 * Anyone who controls a repository controls its `.code-butler/` folder, config.local.json and
 * .env included. Settings there that choose where project content goes, which keys are sent, or
 * which programs run only apply once this device's owner approves them; the approval records a
 * hash, so any later change needs approving again.
 */
export type ProjectTrustStatus = "none-needed" | "trusted" | "untrusted";

export interface ProjectTrust {
  status: ProjectTrustStatus;
  /** Settings that need approval, as dotted paths; ".env" stands for the project .env file. */
  paths: string[];
  hash: string;
}

type ConfigObject = Record<string, any>;

/** Model fields a project may still choose; every other connection field names a destination, key or program. */
const SAFE_MODEL_FIELDS = new Set<string>(["model", "maxTokens"]);
const EMBEDDING_DESTINATION_FIELDS = ["provider", "baseUrl", "apiKeyEnv"] as const;

/** The effective value of every setting in the repo's config files that needs approval. */
export function sensitiveProjectSettings(rootDir: string, merged: ConfigObject, defaultRoots: { codex: string[]; claude: string[] }): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const section of ["extractor", "investigator"] as const) {
    const block = merged[section];
    if (!isRecord(block)) continue;
    for (const key of MODEL_FIELDS) {
      if (!SAFE_MODEL_FIELDS.has(key) && block[key] !== undefined) settings[`${section}.${key}`] = block[key];
    }
  }
  if (isRecord(merged.embeddings)) {
    for (const key of EMBEDDING_DESTINATION_FIELDS) {
      if (merged.embeddings[key] !== undefined) settings[`embeddings.${key}`] = merged.embeddings[key];
    }
  }
  // A repo may always narrow what Butler does, never widen it.
  for (const key of ["allowRemoteModels", "allowRemoteEmbeddings"] as const) {
    if (merged.privacy?.[key] === true) settings[`privacy.${key}`] = true;
  }
  const git = merged.sources?.git;
  if (isRecord(git) && git.repoPath !== undefined && rooted(rootDir, git.repoPath) !== resolve(rootDir)) settings["sources.git.repoPath"] = git.repoPath;
  for (const adapter of ["codex", "claude"] as const) {
    const source = merged.sources?.[adapter];
    if (!isRecord(source)) continue;
    if (source.projectOnly === false) settings[`sources.${adapter}.projectOnly`] = false;
    if (Array.isArray(source.roots) && source.roots.some(root => !defaultRoots[adapter].includes(rooted(rootDir, root)))) {
      settings[`sources.${adapter}.roots`] = source.roots;
    }
  }
  if (merged.globalRules?.enabled === false) settings["globalRules.enabled"] = false;
  if (Array.isArray(merged.globalRules?.exclude) && merged.globalRules.exclude.length) settings["globalRules.exclude"] = merged.globalRules.exclude;
  return settings;
}

/** Compares the repo's current sensitive settings, and the .env file's bytes, with this device's approval. */
export function evaluateProjectTrust(rootDir: string, settings: Record<string, unknown>, envBytes: Buffer | undefined): ProjectTrust {
  const paths = Object.keys(settings).sort();
  if (envBytes) paths.push(".env");
  const hash = sha256(JSON.stringify([paths.map(path => [path, settings[path] ?? null]), envBytes ? sha256(envBytes) : null]));
  if (!paths.length) return { status: "none-needed", paths, hash };
  return { status: readRecord(rootDir)?.hash === hash ? "trusted" : "untrusted", paths, hash };
}

export function recordProjectTrust(rootDir: string, trust: Pick<ProjectTrust, "hash">): void {
  writeJson(recordPath(rootDir), { version: 1, root: canonical(rootDir), hash: trust.hash, trustedAt: new Date().toISOString() });
}

/**
 * Projects registered before trust existed keep the settings they already run with. Runs once
 * per global config directory; `trustAsIs` records a project's current settings.
 */
let migratedFor: string | undefined;
export function migrateRegisteredProjects(trustAsIs: (root: string) => void): void {
  const directory = trustDirectory();
  if (migratedFor === directory) return;
  migratedFor = directory;
  const marker = join(directory, "registered-projects-migrated");
  if (existsSync(marker)) return;
  for (const root of registeredProjectRoots()) {
    try { if (!readRecord(root)) trustAsIs(root); } catch { /* an unreadable project stays untrusted */ }
  }
  writeJson(marker, { migratedAt: new Date().toISOString() });
}

/**
 * Mirrors global-watch's registry layout, which imports config.ts and so cannot be imported here.
 * A project registered within the last hour may have been registered by this very release when
 * an untrusted repository was opened, so only older registrations count.
 */
const MIGRATION_MIN_AGE_MS = 60 * 60 * 1000;
function registeredProjectRoots(): string[] {
  const directory = join(globalConfigDir(), "watch", "projects");
  if (!existsSync(directory)) return [];
  const cutoff = Date.now() - MIGRATION_MIN_AGE_MS;
  return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as { root?: unknown; registeredAt?: unknown };
      const registeredAt = typeof record.registeredAt === "string" ? Date.parse(record.registeredAt) : Number.NaN;
      return typeof record.root === "string" && registeredAt < cutoff && existsSync(record.root) ? [record.root] : [];
    } catch { return []; }
  });
}

function readRecord(rootDir: string): { hash?: string } | undefined {
  const path = recordPath(rootDir);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as { hash?: string }; } catch { return undefined; }
}

const trustDirectory = () => join(globalConfigDir(), "trusted-projects");
const recordPath = (rootDir: string) => join(trustDirectory(), `${sha256(canonical(rootDir))}.json`);

function canonical(rootDir: string): string {
  const root = canonicalCheckoutRoot(rootDir);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function rooted(rootDir: string, value: unknown): string {
  return typeof value === "string" ? (isAbsolute(value) ? resolve(value) : resolve(rootDir, value)) : String(value);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is ConfigObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
