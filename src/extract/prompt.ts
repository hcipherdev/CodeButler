import { SCOPE_EXTRACTION_GUIDANCE } from "../memory/scope.js";
import { STATEMENT_EXTRACTION_GUIDANCE } from "../memory/statement.js";
import type { ExtractorContext } from "../types.js";

/**
 * One prompt for every provider. The evidence shape is spelled out because the parser
 * rejects a memory whose references lack `sourceType`, and models omit fields that
 * the prompt leaves implicit.
 */
export const EXTRACTOR_SYSTEM_PROMPT =
  "Extract durable project memories from the supplied commits and conversations: the reasoning a future engineer would need, " +
  "not facts they could read directly from the code or the docs. Respond with strict JSON shaped as {\"memories\": [...]} and nothing else. " +
  "Memory types: decision = a choice that was made and why, including alternatives when stated; " +
  "constraint = a rule that must or must never be followed, with its reason; " +
  "bug_fix = a defect's symptom, root cause, and fix; " +
  "rejected_approach = an approach that was tried or proposed and then dropped, and why. " +
  "Do not extract document structure, headings, section locations, file contents, test names, or anything stated only as code. " +
  "Each memory is an object with: type; title (a few words); summary (one or two sentences stating the claim); " +
  "reason (why it holds, taken from the evidence; never empty); confidence (0 to 1); dedupeKey (short kebab-case key, the same for the same fact); " +
  "relatedFiles (repository paths); evidence (1 to 3 references). " +
  "Each evidence reference is exactly {\"sourceType\":\"commit\",\"sourceId\":\"<exact commit hash>\"} or " +
  "{\"sourceType\":\"conversation\",\"sourceId\":\"<exact conversation sourceId>\",\"locator\":\"<exact chunk id>\"}. " +
  "Conversation evidence must include the exact supplied source ID and exact supplied chunk ID as locator. " +
  "Copy IDs exactly as supplied. Return {\"memories\": []} when nothing qualifies." +
  SCOPE_EXTRACTION_GUIDANCE + STATEMENT_EXTRACTION_GUIDANCE;

/**
 * Fills a missing evidence `sourceType` when the `sourceId` names exactly one supplied
 * source, so a reference the model under-specified is not lost. IDs not in this batch
 * stay untouched and are rejected as before.
 */
export function withInferredEvidenceTypes(value: unknown, context: ExtractorContext): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { evidence?: unknown }).evidence)) return value;
  const commits = new Set(context.commits.map(commit => commit.hash));
  const conversations = new Set(context.conversations.map(conversation => conversation.sourceId));
  const evidence = ((value as { evidence: unknown[] }).evidence).map(item => {
    if (!item || typeof item !== "object") return item;
    const ref = item as Record<string, unknown>;
    if (ref.sourceType !== undefined || typeof ref.sourceId !== "string") return item;
    if (commits.has(ref.sourceId) && !conversations.has(ref.sourceId)) return { ...ref, sourceType: "commit" };
    if (conversations.has(ref.sourceId) && !commits.has(ref.sourceId)) return { ...ref, sourceType: "conversation" };
    return item;
  });
  return { ...(value as Record<string, unknown>), evidence };
}
