// Purpose: Compiles the CLI/MCP package into dist/ and writes dist/build-info.json.
//
// Usage:
//   node scripts/build/build.mjs    # Build dist/ (also run by `npm run build` and npm prepack)
//
// When scripts/build/build-private.mjs exists, it runs afterwards to build
// components that are not part of the published package.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dist = resolve(root, "dist");
// Preserve verified native release artifacts when npm prepack rebuilds TypeScript,
// and the macOS PKG and Windows MSIX outputs that signed-pkg-localtest.sh and build-signed-installer.ps1 own
// (their tauri builds run this script).
if (dirname(dist) !== resolve(root)) throw new Error("Invalid build output directory");
if (existsSync(dist)) for (const name of readdirSync(dist)) {
  if (name === "native" || name === "macos" || name === "windows") continue;
  const target = join(dist, name);
  if (dirname(target) !== dist) throw new Error("Invalid build output path");
  rmSync(target, { recursive: true, force: true });
}

// Execute the compiler through Node: Windows cannot spawn a .cmd shim directly.
const tsc = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
  stdio: "inherit"
});

if (tsc.error) {
  throw tsc.error;
}

if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

const sourceHash = createHash("sha256");
function fingerprint(path) {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory() && !["__pycache__", "node_modules", ".cache"].includes(entry.name)) fingerprint(name);
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|css|html|rs|ps1|py)$/.test(entry.name)) sourceHash.update(name).update("\0").update(readFileSync(join(root, name))).update("\0");
  }
}
// Desktop sources exist only in the private repository.
for (const path of ["src", "desktop/src", "src-tauri/src", "src-tauri/windows", "scripts"]) if (existsSync(join(root, path))) fingerprint(path);
for (const name of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/windows/AppxManifest.store.xml.in"]) if (existsSync(join(root, name))) sourceHash.update(name).update(readFileSync(join(root, name)));
// CODE_BUTLER_DISTRIBUTION=store (set by scripts/winos/build-signed-installer.ps1) marks a Microsoft Store build,
// which turns off the in-app GitHub updater.
const distribution = process.env.CODE_BUTLER_DISTRIBUTION?.trim() || undefined;
if (distribution && distribution !== "store") throw new Error(`Unknown CODE_BUTLER_DISTRIBUTION "${distribution}"; use "store" or leave it unset.`);
if (distribution) sourceHash.update("distribution\0").update(distribution);
const buildInfo = { version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  buildId: sourceHash.digest("hex"), builtAt: new Date().toISOString(), ...(distribution ? { distribution } : {}) };
writeFileSync(join(dist, "build-info.json"), JSON.stringify(buildInfo, null, 2));

if (process.platform !== "win32") {
  chmodSync("dist/cli.js", 0o755);
}

const privateSteps = join(root, "scripts", "build", "build-private.mjs");
if (existsSync(privateSteps)) await import(pathToFileURL(privateSteps).href);
