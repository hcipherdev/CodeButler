import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function backupClientConfig(path: string): void {
  const copy = `${path}.before-code-butler-${randomUUID()}.bak`;
  copyFileSync(path, copy);
  chmodSync(copy, 0o600);
}

/** Read only regular files. A missing file is distinct from an unreadable one. */
export function readClientConfig(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Settings must be a regular file for direct setup.");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Back up existing settings and compare again immediately before publishing the replacement. */
export function writeClientConfig(path: string, previous: string | undefined, next: string, backup: (path: string) => void): void {
  const temporary = `${path}.code-butler-${randomUUID()}.tmp`;
  const assertUnchanged = () => {
    if (readClientConfig(path) !== previous) throw new Error("Settings changed during setup. Check again before connecting.");
  };
  let staged = false;
  try {
    assertUnchanged();
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(temporary, "wx", previous === undefined ? 0o600 : lstatSync(path).mode & 0o777);
    staged = true;
    try { writeFileSync(fd, next); } finally { closeSync(fd); }
    if (previous !== undefined) backup(path);
    assertUnchanged();
    if (previous === undefined) linkSync(temporary, path); // Exclusive creation.
    else renameSync(temporary, path);
  } finally {
    if (staged) rmSync(temporary, { force: true });
  }
}
