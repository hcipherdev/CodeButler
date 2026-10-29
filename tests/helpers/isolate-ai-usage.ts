// Test setup for src/ai/usage.ts: keeps model-call usage written by any test out of the real ledger.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODE_BUTLER_AI_USAGE_DIR ??= mkdtempSync(join(tmpdir(), "code-butler-ai-usage-"));
