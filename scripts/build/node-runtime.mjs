// Purpose: Provide the official, checksum-pinned Node.js build that the desktop app bundles, so the
//          app's minimum OS comes from nodejs.org's build rather than whatever Node the build machine has.
// Usage:
//   node scripts/build/node-runtime.mjs                     # Download (or reuse) Node for this machine; print its path
//   node scripts/build/node-runtime.mjs darwin x64          # Same for another platform and architecture
//   Imported by scripts/build/prepare-desktop.mjs: await officialNode({ platform, arch }).
// Set CODE_BUTLER_NODE_PATH when running prepare-desktop to bundle a specific node executable instead.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.21.0";
/** From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt; update together with NODE_VERSION. */
export const NODE_ARCHIVES = {
  "darwin-arm64": { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" },
  "darwin-x64": { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" },
  "win32-x64": { file: `node-v${NODE_VERSION}-win-x64.zip`, sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
  "win32-arm64": { file: `node-v${NODE_VERSION}-win-arm64.zip`, sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921" }
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** The executable's path inside the archive, which is named after the archive without its extension. */
function memberPath(platform, file) {
  const folder = file.replace(/\.(tar\.gz|zip)$/, "");
  return platform === "win32" ? `${folder}/node.exe` : `${folder}/bin/node`;
}

/**
 * Returns the path of a verified official node executable, downloading it once into the cache.
 * The archive is checked against the pinned SHA-256 before anything is extracted.
 */
export async function officialNode({
  platform = process.platform,
  arch = process.arch,
  cacheDir = join(root, "node_modules", ".cache", "code-butler-node"),
  fetchImpl = fetch,
  archives = NODE_ARCHIVES,
  baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`,
  tar = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar"
} = {}) {
  const entry = archives[`${platform}-${arch}`];
  if (!entry) throw new Error(`No official Node.js build is pinned for ${platform}-${arch}`);
  const directory = join(cacheDir, `${platform}-${arch}-${entry.sha256.slice(0, 16)}`);
  const executable = join(directory, platform === "win32" ? "node.exe" : "node");
  const marker = join(directory, "archive.sha256");
  if (existsSync(executable) && existsSync(marker) && readFileSync(marker, "utf8").trim() === entry.sha256) return executable;

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const response = await fetchImpl(`${baseUrl}/${entry.file}`);
  if (!response.ok) throw new Error(`Downloading ${entry.file} failed with status ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = sha256(archive);
  if (actual !== entry.sha256) throw new Error(`${entry.file} does not match its pinned SHA-256 (got ${actual}); refusing to use it`);
  const archivePath = join(directory, entry.file);
  writeFileSync(archivePath, archive);
  const extracted = join(directory, "extract");
  mkdirSync(extracted);
  const member = memberPath(platform, entry.file);
  const result = spawnSync(tar, ["-xf", archivePath, "-C", extracted, member], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Extracting node from ${entry.file} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  renameSync(join(extracted, ...member.split("/")), executable);
  if (platform !== "win32") chmodSync(executable, 0o755);
  rmSync(extracted, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  writeFileSync(marker, `${entry.sha256}\n`);
  return executable;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [platform, arch] = process.argv.slice(2);
  officialNode({ ...(platform ? { platform } : {}), ...(arch ? { arch } : {}) })
    .then(path => console.log(path))
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
