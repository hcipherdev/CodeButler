import { z } from "zod";
import { measured } from "../../retrieval/metrics.js";

export const searchMaxCharsSchema = z.number().int().min(2_000).max(200_000).optional()
  .describe("Response size budget in characters (default 40000). Trailing hits are dropped and counted in omitted.");
export function asJsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: measured("serialization",()=>JSON.stringify(value, null, 2)) }]
  };
}

/** For search tools, whose responses are sized against a character budget. */
export function asCompactJsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: measured("serialization",()=>JSON.stringify(value)) }]
  };
}

export function compactOptionalInput<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
