import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { globalConfigDir } from "../config.js";

export function recordUnexpectedDesktopError(error: unknown, phase: string): string | undefined {
  const id = randomUUID().slice(0, 8);
  try {
    const directory = join(globalConfigDir(), "logs");
    const path = join(directory, "desktop-ai-review-errors.log");
    mkdirSync(directory, { recursive: true });
    try { if (statSync(path).size > 1_000_000) writeFileSync(path, ""); } catch { /* A new log has no size yet. */ }
    const value = error as NodeJS.ErrnoException | null;
    // Exclude messages and payloads: either can contain memory text or credentials.
    const frames = error instanceof Error ? error.stack?.split("\n").slice(1, 5).map(frame => frame.trim()) : undefined;
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), id, phase,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof value?.code === "string" ? value.code : undefined,
      frames })}\n`);
    return id;
  } catch { return undefined; }
}

export function recordDesktopTiming(phase: "overview" | "search", gateWaitMs: number, workMs: number): void {
  try {
    const directory = join(globalConfigDir(), "logs");
    const path = join(directory, "desktop-performance.log");
    mkdirSync(directory, { recursive: true });
    try { if (statSync(path).size > 1_000_000) writeFileSync(path, ""); } catch { /* A new log has no size yet. */ }
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), phase,
      gateWaitMs: Math.round(gateWaitMs), workMs: Math.round(workMs) })}\n`);
  } catch { /* Timing must never prevent a desktop read. */ }
}
