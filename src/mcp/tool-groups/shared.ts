import { measured } from "../../retrieval/metrics.js";
export function asJsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: measured("serialization",()=>JSON.stringify(value, null, 2)) }]
  };
}

export function compactOptionalInput<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
