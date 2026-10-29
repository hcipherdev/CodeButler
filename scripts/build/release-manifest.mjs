#!/usr/bin/env node
// Purpose: Sign release installers with the update key and write the latest.json the desktop app checks.
//
// Usage:
//   node scripts/build/release-manifest.mjs --asset darwin-aarch64=dist/macos/Code-Butler-macOS-2.0.0-arm64-signed.pkg
//       # One platform: copies the PKG into dist/release/, signs it, writes dist/release/latest.json
//   node scripts/build/release-manifest.mjs \
//     --asset darwin-aarch64=dist/macos/Code-Butler-macOS-2.0.0-arm64-signed.pkg \
//     --asset darwin-x86_64=dist/macos/Code-Butler-macOS-2.0.0-x86_64-signed.pkg \
//     --asset "windows-x86_64=src-tauri/target/release/bundle/nsis/Code Butler_2.0.0_x64-setup.exe" \
//     --notes docs/release-notes/2.0.0.md
//       # Every platform, with Markdown release notes shown in the app's update dialog
//
// Then upload everything in dist/release/ (installers and latest.json) to the GitHub release
// tagged v<version> on hcipherdev/CodeButler, and mark it as the latest release.
//
// Environment:
//   TAURI_SIGNING_PRIVATE_KEY_PATH      private key (default secrets/updater/code-butler-updater.key)
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password, if it has one (default empty)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const repository = "hcipherdev/CodeButler";
const platforms = new Set(["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);

const args = process.argv.slice(2);
const assets = [];
let notes;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--asset") {
    const [platform, file] = (args[++i] ?? "").split(/=(.*)/s);
    if (!platforms.has(platform)) throw new Error(`Unknown platform "${platform}"; use one of ${[...platforms].join(", ")}`);
    if (!file || !existsSync(file)) throw new Error(`Installer not found for ${platform}: ${file}`);
    if (!/\.(pkg|exe)$/i.test(file)) throw new Error(`Expected a .pkg or .exe installer for ${platform}: ${file}`);
    assets.push({ platform, file: resolve(file) });
  } else if (args[i] === "--notes") {
    notes = readFileSync(args[++i] ?? "", "utf8").trim();
  } else throw new Error(`Unknown option ${args[i]}. See the usage at the top of this script.`);
}
if (!assets.length) throw new Error("Pass at least one --asset <platform>=<installer>. See the usage at the top of this script.");

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(root, "secrets", "updater", "code-butler-updater.key");
if (!existsSync(keyPath)) throw new Error(`Update signing key not found at ${keyPath}`);
const out = join(root, "dist", "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = { version, ...(notes ? { notes } : {}), pub_date: new Date().toISOString(), platforms: {} };
for (const { platform, file } of assets) {
  // GitHub turns spaces in asset names into dots, so use that name here and in the URL.
  const name = basename(file).replace(/\s+/g, ".");
  if (!/^[\w.+-]+$/.test(name)) throw new Error(`Rename the installer to letters, digits, dots, dashes or underscores: ${name}`);
  const target = join(out, name);
  copyFileSync(file, target);
  const signed = spawnSync("npx", ["tauri", "signer", "sign", "-f", keyPath, "-p", process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "", target],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  if (signed.status !== 0) throw new Error(`Signing failed for ${name}`);
  manifest.platforms[platform] = { url: `https://github.com/${repository}/releases/download/v${version}/${name}`, signature: readFileSync(`${target}.sig`, "utf8").trim() };
  console.log(`Signed ${platform}: ${name}`);
}
writeFileSync(join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${join(out, "latest.json")} for v${version}. Upload dist/release/* to the v${version} release on ${repository}.`);
