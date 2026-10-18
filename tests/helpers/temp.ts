import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real path: macOS hands out /var/folders/…, a symlink to /private/var/folders/…, and Butler stores and
 * compares canonical project roots, while rules paths reject symlinks outright.
 */
export function makeTempDir(prefix = "code-butler-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function cleanupTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
