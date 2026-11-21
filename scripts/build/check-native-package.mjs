// Verifies the bundled macOS and Windows crypto helpers and their Cargo.lock files.
// Usage: npm run check:native-package
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertStaticWindowsRuntime } from "./windows-pe-imports.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const normalizeLockfile = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");
const sourceLockfile = normalizeLockfile(readFileSync(join(root, "native", "butler-crypto", "Cargo.lock")));

for (const platform of ["win32-x64", "darwin-x64", "darwin-arm64"]) {
  const directory = join(root, "dist", "native", platform);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const binary = platform === "win32-x64" ? "butler-crypto.exe" : "butler-crypto";
  const binaryPath = join(directory, binary);
  if (manifest.binary !== binary || manifest.sha256 !== digest(readFileSync(binaryPath))) {
    throw new Error(`Native binary integrity check failed: ${platform}`);
  }

  const packagedLockfile = readFileSync(join(directory, "Cargo.lock"));
  if (manifest.cargoLockSha256 !== digest(packagedLockfile)) {
    throw new Error(`Packaged Cargo.lock integrity check failed: ${platform}`);
  }
  // Git checkouts on Windows and Linux can use different line endings.
  if (normalizeLockfile(packagedLockfile) !== sourceLockfile) {
    throw new Error(`Packaged Cargo.lock differs from the source lockfile: ${platform}`);
  }
  if (platform === "win32-x64") assertStaticWindowsRuntime(binaryPath);
}
console.log("All Windows/macOS native package artifacts verified.");
