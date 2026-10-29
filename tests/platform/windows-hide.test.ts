// Tests that every child-process spawn in src/ passes windowsHide, so console programs started from a detached process (the daily memory review) never flash a window on Windows.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");
const SPAWN = /(?<![\w.])(spawnSync|execFileSync|execFile|spawn|execSync)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The full argument list of the call opening at `start`, balanced across nested parentheses. */
function callAt(source: string, start: number): string {
  let depth = 1, index = start;
  while (index < source.length && depth > 0) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")") depth--;
    index++;
  }
  return source.slice(start, index);
}

it("passes windowsHide to every spawned child process", () => {
  const missing: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPAWN)) {
      const call = callAt(source, match.index + match[0].length);
      // Imports and type positions are not calls.
      if (/^\s*\)/.test(call) || /^\s*[\w.]+\s*\)\s*$/.test(call) && !call.includes(",")) continue;
      if (call.includes("windowsHide")) continue;
      // Options passed through a variable are built elsewhere in the same file.
      if (/,\s*[A-Za-z_$][\w$]*\s*\)$/.test(call.trim()) && source.includes("windowsHide")) continue;
      missing.push(`${relative(SRC, file)}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(missing).toEqual([]);
});
