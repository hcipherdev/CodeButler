import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "code-butler-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
