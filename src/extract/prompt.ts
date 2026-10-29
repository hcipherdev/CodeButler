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
  "bug_fix = a defect that was fixed: its symptom, root cause when stated, and the fix that landed; " +
  "rejected_approach = an approach that was tried or proposed and then dropped, and why. " +
  "Do not extract document structure, headings, section locations, file contents, test names, or anything stated only as code. " +
  "Do not extract plans, proposals, or next steps that are not yet decided or done; review, audit, readiness, or status reports and their verdicts or open items; " +
  "or UI layout and placement choices unless a constraint or reason is stated. " +
  "A bug that is described but not yet fixed is not a bug_fix. Title a bug_fix by its fix (\"Recovery code now grants device trust\"), not by its symptom, " +
  "and include statement.fields.symptom and statement.fields.fix. " +
  "Use a confidence below 0.7 when the evidence does not show that a statement is settled. " +
  "Each memory is an object with: type; title (a few words); summary (one or two sentences stating the claim); " +
  "reason (why it holds, taken from the evidence; never empty); confidence (0 to 1); dedupeKey (short kebab-case key, the same for the same fact); " +
  "relatedFiles (repository paths); evidence (1 to 3 references). " +
  "Each evidence reference is exactly {\"sourceType\":\"commit\",\"sourceId\":\"<exact commit hash>\"} or " +
  "{\"sourceType\":\"conversation\",\"sourceId\":\"<exact conversation sourceId>\",\"locator\":\"<exact chunk id>\"}. " +
  "Conversation evidence must include the exact supplied source ID and exact supplied chunk ID as locator. " +
  "Copy IDs exactly as supplied. Return {\"memories\": []} when nothing qualifies. " +
  "Conversation chunks marked \"contextOnly\": true were extracted on an earlier pass: read them only to understand the chunks after them, " +
  "and never return a memory whose only evidence is contextOnly chunks. " +
  "existingMemories, when supplied, lists what the project already records, each with a ref such as \"E1\" and the time its evidence was observed (recordedAt). " +
  "If a memory you return states the same fact as an existing memory of the same type, set \"sameAs\": \"<ref>\" and still return it, so its new evidence is recorded. " +
  "If the supplied commits or conversations show that an existing memory's claim is no longer true (the behavior changed, the decision was reversed, " +
  "or a bug it describes as present was fixed), return the memory that states what is true now with " +
  "\"invalidates\": {\"ref\": \"<ref>\", \"confidence\": 0 to 1, \"why\": \"<one sentence>\"}. " +
  "Only invalidate from evidence newer than that memory's recordedAt, judged by commit and chunk timestamps, " +
  "and never because the material merely does not mention it." +
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
