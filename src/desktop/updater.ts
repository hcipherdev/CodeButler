import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { buildInfo } from "../runtime.js";

/**
 * Public half of `secrets/updater/code-butler-updater.key` (the base64 `.pub` file that
 * `tauri signer generate` writes). Installers are only run after verifying against it.
 */
export const UPDATE_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIwNjRGRjdBNzEwRDBBMzYKUldRMkNnMXhldjlrSUpoeVFpUXFzQmRkY3BWNExmbWlibW1HTkU5Tm1haDlkZHN4NkFPdG1WRDkK";
export const UPDATE_MANIFEST_URL = "https://github.com/hcipherdev/CodeButler/releases/latest/download/latest.json";
/** Where GitHub serves release assets from, including after its download redirect. */
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

export interface UpdateAsset { url: string; signature: string }
export interface UpdateManifest { version: string; notes?: string; pub_date?: string; platforms: Record<string, UpdateAsset> }
export interface UpdateStatus {
  current: string;
  available: boolean;
  version?: string | undefined;
  notes?: string | undefined;
  publishedAt?: string | undefined;
  /** True when the newest release has no installer for this computer. */
  unsupported?: boolean | undefined;
}

/** The manifest key for this computer, matching what `scripts/build/release-manifest.mjs` writes. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return `${os}-${cpu}`;
}

/** Compares release versions numerically; a pre-release (`2.1.0-beta.1`) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => { const [core = "", pre] = value.trim().replace(/^v/, "").split("-", 2); return { parts: core.split(".").map(part => Number.parseInt(part, 10) || 0), pre }; };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Verifies a minisign signature in the base64 form `tauri signer sign` produces: an Ed25519
 * signature over the BLAKE2b-512 hash of the file ("ED"), plus the global signature that
 * binds the trusted comment. Returns false rather than throwing on any malformed input.
 */
export function verifyMinisign(publicKeyBase64: string, signatureBase64: string, data: Buffer): boolean {
  try {
    const keyLine = Buffer.from(publicKeyBase64, "base64").toString("utf8").split(/\r?\n/)[1] ?? "";
    const key = Buffer.from(keyLine, "base64");
    const lines = Buffer.from(signatureBase64, "base64").toString("utf8").split(/\r?\n/);
    const sig = Buffer.from(lines[1] ?? "", "base64");
    const trusted = lines[2] ?? "";
    const global = Buffer.from(lines[3] ?? "", "base64");
    if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") return false;
    if (sig.length !== 74 || sig.subarray(0, 2).toString() !== "ED" || !sig.subarray(2, 10).equals(key.subarray(2, 10))) return false;
    if (!trusted.startsWith("trusted comment: ") || global.length !== 64) return false;
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.subarray(10).toString("base64url") }, format: "jwk" });
    const signature = sig.subarray(10);
    const hashed = createHash("blake2b512").update(data).digest();
    return verify(null, hashed, publicKey, signature)
      && verify(null, Buffer.concat([signature, Buffer.from(trusted.slice("trusted comment: ".length))]), publicKey, global);
  } catch { return false; }
}

function parseManifest(value: unknown): UpdateManifest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const platforms = record?.platforms && typeof record.platforms === "object" ? record.platforms as Record<string, unknown> : undefined;
  if (typeof record?.version !== "string" || !platforms) throw new Error("The update information is not in the expected format.");
  const assets: Record<string, UpdateAsset> = {};
  for (const [key, asset] of Object.entries(platforms)) {
    const entry = asset && typeof asset === "object" ? asset as Record<string, unknown> : undefined;
    if (typeof entry?.url === "string" && typeof entry.signature === "string") assets[key] = { url: entry.url, signature: entry.signature };
  }
  return { version: record.version, platforms: assets,
    ...(typeof record.notes === "string" ? { notes: record.notes } : {}), ...(typeof record.pub_date === "string" ? { pub_date: record.pub_date } : {}) };
}

const manifestUrl = () => process.env.CODE_BUTLER_UPDATE_URL?.trim() || UPDATE_MANIFEST_URL;

async function fetchManifest(fetchImpl: typeof fetch): Promise<UpdateManifest> {
  let response: Response;
  try { response = await fetchImpl(manifestUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error("Could not reach the update server. Check the network and try again."); }
  if (response.status === 404) throw new Error("No release has been published yet.");
  if (!response.ok) throw new Error(`The update server answered with status ${response.status}.`);
  return parseManifest(await response.json());
}

/** Whether a newer release than this build exists for this computer. Never downloads anything. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch, current: string = buildInfo.version): Promise<UpdateStatus> {
  const manifest = await fetchManifest(fetchImpl);
  const newer = compareVersions(manifest.version, current) > 0;
  const supported = Boolean(manifest.platforms[platformKey()]);
  return { current, available: newer && supported, version: manifest.version, notes: manifest.notes, publishedAt: manifest.pub_date, ...(newer && !supported ? { unsupported: true } : {}) };
}

export const updatesDirectory = () => join(globalConfigDir(), "updates");

/**
 * Downloads this computer's installer for `version`, verifies its signature, and records it in
 * `updates/pending.json` for the desktop shell to launch. The URL always comes from a fresh copy
 * of the manifest, never from the page, and only GitHub release hosts are accepted.
 */
export async function downloadUpdate(version: string, fetchImpl: typeof fetch = fetch, current: string = buildInfo.version, publicKey: string = UPDATE_PUBLIC_KEY): Promise<{ version: string; file: string }> {
  const manifest = await fetchManifest(fetchImpl);
  if (manifest.version !== version) throw new Error("A newer release appeared meanwhile. Check for updates again.");
  if (compareVersions(version, current) <= 0) throw new Error("This version is already installed.");
  const asset = manifest.platforms[platformKey()];
  if (!asset) throw new Error("This release has no installer for this computer.");
  const source = new URL(asset.url);
  if (source.protocol !== "https:" || !DOWNLOAD_HOSTS.has(source.hostname)) throw new Error("The installer is not hosted on the expected release site.");
  const name = basename(decodeURIComponent(source.pathname));
  if (!/^[\w.+-]+\.(pkg|exe)$/i.test(name)) throw new Error("The installer has an unexpected file type.");

  let response: Response;
  try { response = await fetchImpl(source.href, { signal: AbortSignal.timeout(15 * 60_000) }); }
  catch { throw new Error("The download failed. Check the network and try again."); }
  if (!response.ok) throw new Error(`The download failed with status ${response.status}.`);
  const final = new URL(response.url || source.href);
  if (final.protocol !== "https:" || !DOWNLOAD_HOSTS.has(final.hostname)) throw new Error("The download was redirected to an unexpected site.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_INSTALLER_BYTES) throw new Error("The installer is larger than expected.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_INSTALLER_BYTES) throw new Error("The installer is larger than expected.");
  if (!verifyMinisign(publicKey, asset.signature, bytes)) throw new Error("The installer's signature did not match. It was not saved; try again later.");

  // Only the newest verified installer is kept.
  const directory = updatesDirectory();
  mkdirSync(directory, { recursive: true });
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) rmSync(join(directory, entry), { recursive: true, force: true });
  const file = join(directory, name);
  writeFileSync(file, bytes, { mode: 0o600 });
  writeFileSync(join(directory, "pending.json"), JSON.stringify({ version, file, sha256: createHash("sha256").update(bytes).digest("hex") }, null, 2));
  return { version, file };
}
