import type { Binding } from "../cloud/state.js";
import type { ProjectConnectionInspection } from "../cloud/project-connections.js";
import type { SecretSyncStatus } from "../secrets/sync.js";
import type { DesktopAccountStatus } from "./account.js";
import type { AutomaticSyncStatus } from "../cloud/sync-owner.js";
import type { ProjectSummary } from "../storage/store.js";
import type { MemoryQualityStatus, MemoryReviewAction, MemorySearchResult } from "../types.js";
import type { MemoryCorrectionInput, ResolveMemoryReviewResult } from "../memory/review.js";
import type { ProjectOperationStatus } from "../cloud/gate.js";
import type { SyncProgress } from "../cloud/sync-progress.js";
import type { ProjectSummaryRefreshResult, ProjectSummaryStatus } from "../project-summary/service.js";
import type { WatchRunStatus, WatchedProject } from "../global-watch.js";
import type { BuildInfo, RuntimeRecord } from "../runtime.js";
import type { DesktopReconciliationSelection, DesktopReconciliationPreview, MemoryReconciliationRun } from "../memory/reconciliation.js";
import type { WordingSelection } from "../memory/wording.js";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export type DesktopRequest =
  | {version:1;action:"memory.topic.preview";root:string;prefixes:string[];layer?:string;reach?:import("../retrieval/tiers.js").MemoryReach;owner?:"self"|"peer"|"any"}
  | {version:1;action:"memory.history";root:string;id:string;category:"candidate"|"promoted";offset?:number;limit?:number}
  | {version:1;action:"memory.handbook"|"memory.topics.suggest";root:string;reach?:import("../retrieval/tiers.js").MemoryReach;owner?:"self"|"peer"|"any"}
  | {version:1;action:"memory.topic.page";root:string;id:string;reach?:import("../retrieval/tiers.js").MemoryReach;owner?:"self"|"peer"|"any";offset?:number;limit?:number}
  | ({version:1;action:"memory.topic.save";root:string}&import("../memory/topics.js").SaveTopicInput)
  | {version:1;action:"memory.topic.membership";root:string;topicId:string;memoryId:string;mode:"include"|"exclude"|"default"}
  | {version:1;action:"memory.export";root:string;dryRun?:boolean;force?:boolean}
  | import("../rules/desktop.js").RulesDesktopRequest
  | { version: 1; action: "account.status" | "account.summary" | "account.logout" | "account.bootstrap" | "account.enrollment.poll" | "account.devices" | "account.secrets.review" }
  | { version: 1; action: "account.capabilities"; server: string }
  | { version: 1; action: "account.challenge"; server: string; email: string; purpose: "register" | "login" | "reset" }
  | { version: 1; action: "account.verify"; server: string; email: string; challengeId: string; code: string }
  | { version: 1; action: "account.register"; server: string; email: string; challengeId: string; code: string; password: string }
  | { version: 1; action: "account.password.login"; server: string; email: string; password: string }
  | { version: 1; action: "account.password.set"; password: string; currentPassword?: string }
  | { version: 1; action: "account.password.reset.verify"; server: string; challengeId: string; code: string }
  | { version: 1; action: "account.password.reset.complete"; server: string; resetToken: string; password: string }
  | { version: 1; action: "account.passkey.start"; server: string; kind: "login" | "add"; redirectUri: string; label?: string }
  | { version: 1; action: "account.passkey.exchange"; server: string; kind: "login" | "add"; code: string; verifier: string; state: string }
  | { version: 1; action: "account.passkeys" }
  | { version: 1; action: "account.passkey.remove"; id: string }
  | { version: 1; action: "account.vault.prepare"; filePath: string; label?: string }
  | { version: 1; action: "account.vault.confirm"; filePath: string; code: string }
  | { version: 1; action: "account.device.request"; label?: string }
  | { version: 1; action: "account.device.approve"; fingerprint: string }
  | { version: 1; action: "account.device.complete"; requestId: string; fingerprint: string }
  | { version: 1; action: "account.device.revoke"; deviceId: string; confirmed?: boolean }
  | { version: 1; action: "account.device.cancel"; requestId: string }
  | { version: 1; action: "account.recovery.restore"; filePath: string; code: string; label?: string }
  | { version:2; action:"memory.freshness"; root:string }
  | ({ version:2; action:"memory.page"; root:string } & import("../retrieval/tiers.js").TierInput)
  | { version:2; action:"memory.tiers"; root:string }
  | { version:1; action:"memory.working.detail"; root:string; id:string }
  | {version:1;action:"memory.working.keep";root:string;id:string}
  | ({version:1; action:"memory.working.candidate"; root:string} & import("../memory/working.js").WorkingCandidateInput)
  | {version:1; action:"memory.promote-project"; root:string; id:string; category:"candidate"|"promoted"; reason:string}
  | { version: 1; action: "projects.list" }
  | { version: 1; action: "watcher.status" }
  | { version: 1; action: "watcher.runtime-details" }
  | { version: 1; action: "projects.inspect"; root: string }
  | { version: 1; action: "projects.add"; root: string; initialize?: boolean }
  | { version: 1; action: "projects.remove"; root: string; mode?: "list" | "local" | "everywhere"; confirmed?: boolean }
  | { version: 1; action: "project.overview"; root: string }
  | { version: 1; action: "cloud.sync.status"; root: string }
  | { version: 1; action: "cloud.projects.list"; refresh?: boolean }
  | { version: 1; action: "cloud.project.inspect"; root: string; refresh?: boolean }
  | { version: 1; action: "cloud.project.link"; root: string; projectId: string; approveRemote?: boolean; confirmed?: boolean; confirmation?: import("../cloud/project-link-review.js").LinkConfirmation }
  | { version: 1; action: "cloud.project.link-review"; root: string; projectId: string; intent: "recover" | "share-remote" }
  | { version: 1; action: "cloud.connection.repair"; root: string; key: string; fingerprint: string; confirmed?: boolean }
  | { version: 1; action: "cloud.project.make-portable"; root: string; approveRemote?: boolean; confirmed?: boolean }
  | { version: 1; action: "cloud.project.separate"; root: string; confirmed?: boolean }
  | { version: 1; action: "cloud.sync.review"; root: string }
  | { version: 1; action: "cloud.sync.resolve"; root: string; choice: "local" | "cloud" | "merge"; review: import("../cloud/encrypted-coordinator.js").SyncReview; confirmed?: boolean }
  | { version: 1; action: "project.operation.status"; root: string }
  | { version: 1; action: "project.operation.release-intent"; root: string; intentId: string }
  | { version: 1; action: "project.summary.refresh"; root: string; force?: boolean }
  | { version: 1; action: "memory.search"; root: string; query: string; qualityStatus?: MemoryQualityStatus | "all"; offset?: number; limit?: number }
  | { version: 1; action: "memory.detail"; root: string; id: string }
  | { version: 1; action: "memory.review.resolve"; root: string; memoryId: string; category: "candidate" | "promoted"; reviewAction: MemoryReviewAction; reason?: string; reviewToken?: string; correction?: MemoryCorrectionInput }
  | { version: 1; action: "memory.ai.preview"; root: string; mode?: "reconcile"; selection: DesktopReconciliationSelection; intentId?: string }
  | { version: 1; action: "memory.ai.preview"; root: string; mode: "wording"; selection: WordingSelection; intentId?: string }
  | { version: 1; action: "memory.ai.status"; root: string;mode?:"reconcile"|"wording"; runId?: string }
  | { version: 1; action: "memory.ai.results"; root: string;mode?:"reconcile"|"wording"; runId: string }
  | { version: 1; action: "memory.ai.apply"; root: string; mode?: "reconcile"; runId: string; itemIds: string[]; applyCorrections?: boolean; forceOffline?: boolean }
  | { version: 1; action: "memory.ai.apply"; root: string; mode: "wording"; runId: string; itemIds: string[] }
  | { version: 1; action: "memory.ai.revert"; root: string;mode?:"reconcile"|"wording"; runId: string; forceOffline?: boolean }
  | { version: 1; action: "cloud.sync.set-enabled"; root: string; enabled: boolean; confirmed?: boolean; createNew?: boolean; approveRemote?: boolean; projectId?: string; confirmation?: import("../cloud/project-link-review.js").LinkConfirmation }
  | { version: 1; action: "secrets.sync.status" | "secrets.sync.now"; root: string }
  | { version: 1; action: "secrets.sync.set-enabled"; root: string; enabled: boolean; confirmed?: boolean }
  | { version: 1; action: "secrets.sync.link"; root: string; vaultId: string; confirmed?: boolean }
  | { version: 1; action: "secrets.sync.resolve"; root: string; path: string; choice: "local" | "remote"; confirmed?: boolean }
  | { version: 1; action: "secrets.recovery.prepare"; root: string; filePath: string }
  | { version: 1; action: "secrets.recovery.confirm"; root: string; filePath: string; code: string }
  | { version: 1; action: "secrets.recovery.restore"; root: string; filePath: string; code: string }
  | { version: 1; action: "secrets.access.request" | "secrets.access.complete" }
  | { version: 1; action: "secrets.access.vaults" | "secrets.access.devices" | "secrets.access.status" }
  | { version: 1; action: "secrets.access.approve"; code: string; confirmed?: boolean }
  | { version: 1; action: "secrets.access.revoke"; deviceId: string; confirmed?: boolean };

export interface DesktopReconciliationResults {
  run: MemoryReconciliationRun;
  citations: Record<string, Array<{ id: string; label: string; kind: string; content: string }>>;
  memories: Record<string, { title: string; summary: string }>;
}

export interface DesktopMemory extends MemorySearchResult {
  canPolishWording?:boolean;
  reviewActions: MemoryReviewAction[];
  canPromoteToProject?: boolean;
}

export interface DesktopProject extends WatchedProject {
  name: string;
  available: boolean;
  lastRun?: WatchRunStatus;
  lastCloudRun?: WatchRunStatus;
}

export interface DesktopWatcherStatus {
  build?: BuildInfo;
  processes?: RuntimeRecord[];
  installed: boolean;
  running: boolean;
  platform: string;
  label: string;
  logsDir: string;
  pid?: number;
}

export interface DesktopProjectList {
  retrievalEngine?: "published" | "legacy";
  projects: DesktopProject[];
  watcher?: DesktopWatcherStatus;
}

export interface DesktopProjectInspection {
  root: string;
  status: "ready" | "needs-init" | "needs-upgrade" | "busy" | "invalid";
  missing: Array<"config" | "database" | "summary" | "AGENTS.md" | "CLAUDE.md">;
  issue?: string;
}

export interface DesktopProjectAddResult {
  project: DesktopProject;
  initialized: boolean;
  summaryFallback: boolean;
  backupFiles: string[];
  warnings: string[];
  cloudSetup?: import("../cloud/auto-connect.js").AutomaticProjectSetup;
}

export interface DesktopCloudStatus {
  recognition?: ProjectConnectionInspection["recognition"];
  connectionProblem?: string;
  projectIdentity?: string;
  projectId?: string;
  storage?: Binding["storage"];
  enabled: boolean;
  encryptionVersion?: number;
  label?: string;
  status: string;
  revision?: number;
  lastSync?: string;
  pendingSync?: boolean;
  queuedReason?: "local" | "remote";
  queuedSince?: string;
  runningSince?: string;
  lastCompletedAt?: string;
  lastQueueWaitMs?: number;
  syncError?: string;
  conflictReason?: import("../cloud/state.js").Binding["conflictReason"];
  lastMerge?: import("../cloud/state.js").Binding["lastMerge"];
  deferredReason?: string;
  timings?: AutomaticSyncStatus["timings"];
}

export interface DesktopProjectOverview {
  project: DesktopProject;
  narrative: {
    exists: boolean;
    summary: string;
    status: ProjectSummaryStatus;
  };
  memory: ProjectSummary;
  cloud: DesktopCloudStatus;
  tiers?: import("../retrieval/tiers.js").MemoryTierCounts;
  working?: import("../retrieval/tiers.js").WorkingMemory[];
  freshness?: import("../retrieval/index.js").RetrievalFreshness;
}

export type DesktopResult =
  | ReturnType<typeof import("../memory/topics.js").previewHandbookTopic>
  | ReturnType<typeof import("../memory/events.js").memoryHistory>
  | ReturnType<typeof import("../memory/topics.js").readHandbook>
  | ReturnType<typeof import("../memory/topics.js").readHandbookTopic>
  | ReturnType<typeof import("../memory/topics.js").suggestHandbookTopics>
  | ReturnType<typeof import("../memory/topics.js").saveMemoryTopic>
  | ReturnType<typeof import("../memory/topics.js").setTopicMembership>
  | ReturnType<typeof import("../memory/export.js").exportMemoryHandbook>
  | import("../rules/desktop.js").RulesDesktopResult
  | DesktopAccountStatus
  | { registrationEnabled: boolean; passwordEnabled: boolean; passkeyEnabled: boolean }
  | { challengeId: string; expiresAt: number }
  | { resetToken: string; expiresAt: number }
  | { reset: true } | { removed: true }
  | { url: string; verifier: string; state: string }
  | Array<{ id: string; name: string; createdAt: number; lastUsed?: number }>
  | { remoteRevoked: boolean }
  | { code: string }
  | { initialized: true } | { enrolled: true } | { cancelled: true } | { restored: true }
  | { approved: true } | { revoked: true }
  | { status: "none" | "pending" | "enrolled" | "cancelled" | "expired" | "revoked"; expiresAt?: number }
  | Array<{ id: string; label: string; current: boolean }>
  | import("./bootstrap.js").AccountBootstrapResult
  | { vaults: Array<{ id: string; parentProjectId?: string; status: "unassociated" | "pending" | "migrated" }> }
  | { requestId: string; fingerprint: string; expiresAt: number }
  | { fingerprint: string }
  | { freshness:import("../retrieval/index.js").RetrievalFreshness }
  | import("../retrieval/index.js").RetrievalPage
  | import("../retrieval/tiers.js").TierPage
  | ReturnType<typeof import("../retrieval/tiers.js").readPublishedTiers>
  | import("../types.js").TemporaryMemory
  | ReturnType<typeof import("../memory/working.js").createWorkingCandidate>
  | ReturnType<typeof import("../memory/layer-service.js").updateMemoryLayer>
  | DesktopProjectList
  | DesktopWatcherStatus
  | { processes: RuntimeRecord[] }
  | DesktopProjectInspection
  | DesktopProjectAddResult
  | DesktopProject
  | DesktopProjectOverview
  | DesktopCloudStatus
  | import("../cloud/project-connections.js").CloudProjectList
  | import("../cloud/project-connections.js").ProjectConnectionInspection
  | import("../cloud/project-link-review.js").ProjectLinkReview
  | import("../cloud/encrypted-coordinator.js").SyncReview
  | { identity: string }
  | SecretSyncStatus
  | import("../secrets/access.js").SecretsAccessStatus
  | { code: string; requested: number; alreadyEnrolled: number }
  | { approved: number; pending: number; failedVaults: string[] }
  | { enrolled: number; pending: number }
  | { revoked: number; pending: number; failedVaults: string[] }
  | string[]
  | Array<{ id: string; label: string; projects: number }>
  | { operation?: ProjectOperationStatus & { progress?: SyncProgress } }
  | { released: true }
  | ProjectSummaryRefreshResult
  | DesktopMemory[]
  | DesktopMemory
  | ResolveMemoryReviewResult
  | DesktopReconciliationPreview
  | MemoryReconciliationRun
  | DesktopReconciliationResults
  | { run?: MemoryReconciliationRun };

export interface DesktopSuccess<T extends DesktopResult = DesktopResult> {
  version: 1;
  ok: true;
  result: T;
}

export interface DesktopFailure {
  version: 1;
  ok: false;
  error: {
    code: "invalid-request" | "confirmation-required" | "not-registered" | "not-found" | "stale-review" | "stale-rule" | "busy" | "internal";
    message: string;
  };
}

export type DesktopResponse<T extends DesktopResult = DesktopResult> = DesktopSuccess<T> | DesktopFailure;

export function desktopCloudStatus(state: Binding | undefined, sync: AutomaticSyncStatus = { pending: false }, deferredReason?: string): DesktopCloudStatus {
  if (!state) return { enabled: false, status: "not-configured" };
  const result: DesktopCloudStatus = {
    enabled: state.enabled,
    status: state.enabled || ["detached", "deleted"].includes(state.status) ? state.status : "disabled"
  };
  result.projectId = state.projectId;
  result.recognition = state.status === "deleted" ? "deleted" : state.status === "detached" ? "unlinked" : state.status === "authentication" ? "unavailable" : state.projectIdentity ? "existing" : "legacy";
  if (state.status === "connection-repair-required") { result.recognition = "repair-required"; result.connectionProblem = state.syncError ?? "Connection needs review."; result.status = state.status; }
  if (state.syncError && /identity|Git remote changed/.test(state.syncError)) { result.recognition = /Git remote changed/.test(state.syncError) ? "remote-changed" : "conflict"; result.connectionProblem = state.syncError; }
  if (state.projectIdentity) result.projectIdentity = state.projectIdentity;
  if (state.encryptionVersion !== undefined) result.encryptionVersion = state.encryptionVersion;
  if (state.label !== undefined) result.label = state.label;
  if (state.revision !== undefined) result.revision = state.revision;
  if (state.storage !== undefined) result.storage=state.storage;
  if (state.lastSync !== undefined) result.lastSync = state.lastSync;
  if (state.syncError !== undefined) result.syncError = state.syncError;
  if (state.conflictReason !== undefined) result.conflictReason = state.conflictReason;
  if (state.lastMerge !== undefined) result.lastMerge = state.lastMerge;
  if (deferredReason !== undefined) result.deferredReason = deferredReason;
  if (sync.pending && state.enabled) { result.pendingSync = true; result.queuedReason = sync.queuedReason ?? "local"; }
  if (sync.queuedSince !== undefined) result.queuedSince = sync.queuedSince;
  if (sync.runningSince !== undefined) result.runningSince = sync.runningSince;
  if (sync.lastCompletedAt !== undefined) result.lastCompletedAt = sync.lastCompletedAt;
  if (sync.lastQueueWaitMs !== undefined) result.lastQueueWaitMs = sync.lastQueueWaitMs;
  if (sync.timings !== undefined) result.timings = sync.timings;
  return result;
}
