import type { AiConnectionKind, AiJob } from "../types.js";
import { AiConnectionError } from "./errors.js";
import { explicitAiTrigger } from "./usage.js";

/**
 * Subscription-backed connections spend a person's own plan. Anthropic allows its plan only through the
 * person's unmodified Claude Code, for ordinary individual use, so Code Butler runs it only for work the
 * person starts. Neither plan may serve the hosted sync service.
 */
export const CLAUDE_CODE_JOBS: readonly AiJob[] = ["review", "wording", "summary", "rules"];
export const CLAUDE_CODE_USER_ONLY =
  "Claude Code runs only for AI review, summary refresh and rules drafting that you start, never in the background";

type PolicyModel = { connectionKind?: AiConnectionKind | undefined };

let hostedService = false;
/** Set once by the hosted sync service at startup; subscription plans are never used there. */
export function markHostedService(): void { hostedService = true; }
export function hostedServiceMarked(): boolean { return hostedService; }

export function isSubscriptionKind(kind: AiConnectionKind | undefined): boolean {
  return kind === "chatgpt" || kind === "claude-code";
}

/** True when the job's model may only run inside work a person started. */
export function runsOnlyWhenStarted(model: PolicyModel | undefined): boolean {
  return model?.connectionKind === "claude-code";
}

/** Throws before any request leaves the machine when this connection may not serve this call. */
export function assertConnectionAllowed(model: PolicyModel, job: AiJob): void {
  if (hostedService && isSubscriptionKind(model.connectionKind)) {
    throw new AiConnectionError("Subscription plans are never used by the hosted sync service");
  }
  if (model.connectionKind !== "claude-code") return;
  // The watch-token fallback labels unattended work (git hooks, MCP tools, timers) as "user"; only an
  // explicit mark from an entry point a person drives counts.
  if (!CLAUDE_CODE_JOBS.includes(job) || explicitAiTrigger() !== "user") throw new AiConnectionError(CLAUDE_CODE_USER_ONLY);
}
