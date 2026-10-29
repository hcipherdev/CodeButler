import { existsSync, statSync } from "node:fs";
import { rulesRequestSchemas, handleRulesDesktopRequest, StaleRuleError, type RulesDesktopDependencies } from "../rules/desktop.js";
import { assertOrdinaryProject } from "../rules/identity.js";
import { retrievalEnabled } from "../retrieval/paths.js";
import { readPublishedMemories, readPublishedDetail, readPublishedSummary, withPublishedIndex } from "../retrieval/index.js";
import { scheduleRetrieval, requestRetrievalRefresh } from "../retrieval/worker.js";
import { withReadCache } from "../retrieval/read-cache.js";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

import { projectOperation } from "../cloud/client.js";
import { automaticSyncStatus, requestAutomaticSync } from "../cloud/sync-owner.js";
import { OperationDeferredError, errorOutcome, type OperationOutcome } from "../cloud/outcome.js";
import { readProjectOperationStatus, withProjectGate, type ProjectOperationStatus } from "../cloud/gate.js";
import { beginForegroundIntent, releaseForegroundIntent, renewForegroundIntent } from "../cloud/foreground.js";
import { binding, canonicalRoot, stateDirectory, type Binding } from "../cloud/state.js";
import { readSyncProgress } from "../cloud/sync-progress.js";
import { setEncryptedCloudSyncEnabled } from "../cloud/sync-toggle.js";
import { queueAutomaticConnection, retryAutomaticConnection, pauseAutomaticConnection, type AutomaticConnectionOptions } from "../cloud/auto-connect.js";
import { bootstrapAccount, type AccountBootstrapOptions } from "./bootstrap.js";
import { cloudProjectList, inspectProjectConnection, connectCloudProject, makeProjectPortable, separateProjectIdentity } from "../cloud/project-connections.js";
import { reviewProjectConflict, resolveProjectConflict } from "../cloud/project-review.js";
import { reviewProjectLink, linkReviewSchema } from "../cloud/project-link-review.js";
import { migrateCheckout } from "../cloud/checkout-repair.js";
import { selectedCloudClient } from "../cloud/project-connections.js";
import { encryptedSecretsSync, setSecretsSyncEnabled, secretsSyncStatus, linkSecretsVault, prepareSecretsRecovery, confirmSecretsRecovery, resolveSecretsConflict } from "../secrets/sync.js";
import { requestAllSecretsAccess, approveAllSecretsAccess, completeAllSecretsAccess, revokeSecretsDevice, restoreSecretsProject, listSecretsVaults, listSecretsDevices, secretsAccessStatus } from "../secrets/access.js";
import { EncryptionError } from "../cloud/crypto-helper.js";
import { automaticReviewPolicy, globalConfigDir, loadProjectConfig } from "../config.js";
import { assertJobConfigured } from "../memory/reconciliation-provider.js";
import { buildInfo, runtimeDiagnostics } from "../runtime.js";
import {
  globalWatchStatus,
  listWatchedProjectStatuses,
  recordManualWatchRun,
  listWatchedProjects,
  registerWatchedProject,
  recordWatchedCloudConnection,
  unregisterWatchedProject,
  type WatchedProject
} from "../global-watch.js";
import { getProjectSummaryStatus, readProjectBrief, refreshProjectSummary } from "../project-summary/service.js";
import { aiClientStatus, connectAiClient } from "./ai-clients.js";
import { listConnectionModels, readAiSettings, removeConnectionKey, saveAiSettings, setConnectionKey, testConnection } from "./ai-settings.js";
import { checkForUpdate, downloadUpdate } from "./updater.js";
import type { AiSettings, ProjectConfig } from "../types.js";
import { importNewGitCommits, ingestionOutcomes, syncWatchedProjectMemory, type SyncRunResult } from "../sync/service.js";
import { memoryScopeSchema } from "../memory/scope.js";
import { isPeerLayer } from "../memory/peer-layer.js";
import { memoryStatementSchema } from "../memory/statement.js";
import { presentMemory, sharingLabel } from "../memory/presentation.js";
import { readPublishedTierPage, readPublishedTiers, readPublishedWorkingDetail, readCanonicalTierPage, readCanonicalFreshness } from "../retrieval/tiers.js";
import { createWorkingCandidate } from "../memory/working.js";
import { memoryStatementFieldsSchema } from "../memory/statement.js";
import { updateMemoryLayer } from "../memory/layer-service.js";
import { readMemoryKnowledge } from "../memory/knowledge.js";
import { memoryHistory, type KnowledgeSnapshot } from "../memory/events.js";
import { readHandbook, readHandbookTopic, suggestHandbookTopics, saveMemoryTopic, setTopicMembership, previewHandbookTopic } from "../memory/topics.js";
import { exportMemoryHandbook } from "../memory/export.js";
import { previewMemoryWording, runMemoryWording, readMemoryWording, applyMemoryWording, type WordingSelection } from "../memory/wording.js";
import { resolveMemoryReview, StaleMemoryReviewError } from "../memory/review.js";
import {
  applyMemoryReconciliation,
  continueDesktopMemoryReconciliation,
  planMemoryReconciliation,
  previewDesktopMemoryReconciliation,
  readDesktopMemoryReconciliationStatus,
  readDesktopMemoryReconciliationResults,
  revertMemoryReconciliation,
  type MemoryReconciliationDependencies,
  type ReconciliationProgress
} from "../memory/reconciliation.js";
import type { ProjectSummaryOperationOptions } from "../project-summary/service.js";
import { initializeProjectMemory } from "../project-initialization.js";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { getWatchServiceStatus, installWatchService } from "../watch-service.js";
import {
  DESKTOP_PROTOCOL_VERSION,
  desktopCloudStatus,
  type DesktopProject,
  type DesktopProjectAddResult,
  type DesktopProjectInspection,
  type DesktopProjectList,
  type DesktopProjectOverview,
  type DesktopSourceCheck,
  type DesktopMemory,
  type DesktopRequest,
  type DesktopResult,
  type DesktopWatcherStatus
} from "./contracts.js";
import { recordDesktopTiming, recordUnexpectedDesktopError } from "./diagnostics.js";
import { inspectDesktopProject } from "./inspection.js";
import { removeDesktopProject } from "./removal.js";
import { clearProjectRemoved } from "../cloud/removal-state.js";
import { accountCapabilities, accountChallenge, accountLogout, accountSummary, accountVerify, accountRegister, accountPasswordLogin, accountSetPassword, accountResetVerify, accountResetComplete, accountPasskeyStart, accountPasskeyExchange, accountPasskeys, accountPasskeyRemove, accountDevices, accountDeviceRevoke, deviceApprove, deviceCancel, deviceComplete, deviceRequest, enrollmentPoll, localAccountStatus, recoveryRestore, vaultConfirm, vaultPrepare } from "./account.js";
import type { MemorySearchResult } from "../types.js";

const rootSchema = z.string().trim().min(1).max(32_767);
const aiIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const aiChoiceSchema = z.object({ connection: aiIdSchema, model: z.string().trim().min(1).max(200), maxTokens: z.number().int().positive().max(200_000).optional() }).strict();
const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const aiSettingsSchema = z.object({
  connections: z.record(aiIdSchema, z.object({
    kind: z.string().max(40), label: z.string().max(80).optional(), baseUrl: z.string().max(500).optional(),
    apiKeyEnv: envNameSchema.optional(), workspaceIdEnv: envNameSchema.optional(), regionEnv: envNameSchema.optional(),
    workspaceId: z.string().max(200).optional(), region: z.string().max(200).optional(),
    dataCollection: z.enum(["allow", "deny"]).optional(), keyUpdatedAt: z.string().max(64).optional(), keySavedToEnv: z.literal(true).optional()
  }).strict()).optional(),
  tiers: z.object({ fast: aiChoiceSchema.optional(), smart: aiChoiceSchema.optional() }).strict().optional(),
  jobs: z.record(z.enum(["extraction", "review", "wording", "summary", "investigator", "rules", "consolidation"]),
    z.union([aiChoiceSchema, z.object({ tier: z.enum(["fast", "smart"]) }).strict()])).optional(),
  budgets: z.object({ backgroundDailyTokens: z.number().int().positive().max(10_000_000_000).nullable().optional() }).strict().optional()
}).strict();

/** Settings errors are written for people (validation, keychain, network), so they reach the page as-is. */
async function aiSettingsAction<T>(work: () => Promise<T> | T): Promise<T> {
  try { return await work(); }
  catch (error) { throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message.replace(/^global /, "") : "The AI settings could not be changed."); }
}
const accountServerSchema = z.string().trim().min(1).max(2048);
const accountEmailSchema = z.string().trim().max(254).email();
const accountCodeSchema = z.string().regex(/^\d{8}$/);
const accountPasswordSchema = z.string().min(1).max(1024);
const recoveryCodeSchema = z.string().min(1).max(256);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const accountLabelSchema = z.string().trim().min(1).max(100);
const intentIdSchema = z.string().uuid();
const aiSelectionSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("selected"),items:z.array(z.object({memoryId:z.string().min(1).max(256),category:z.enum(["candidate","promoted"])}).strict()).min(1).max(1000)}).strict(),
  z.object({ kind: z.literal("all"), limit: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("active"), limit: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("needs_review"), limit: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("quarantined"), limit: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("single"), memoryId: z.string().min(1).max(256), category: z.enum(["candidate", "promoted"]) }).strict()
]);
const aiRunSchema = z.object({
  mode:z.enum(["reconcile","wording"]).optional(),
  version: z.literal(1), action: z.literal("memory.ai.run"), root: rootSchema,
  selection: aiSelectionSchema.optional(), continueRunId: z.string().min(1).max(256).optional(),
  expectedSelectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  tokenCap: z.number().int().min(1).max(100_000_000)
}).strict().refine((value) => (value.selection === undefined) !== (value.continueRunId === undefined), "Choose a selection or run to continue");
const requestSchema = z.discriminatedUnion("action", [
  z.object({version:z.literal(1),action:z.literal("memory.topic.preview"),root:rootSchema,prefixes:z.array(z.string().max(512)).max(100),layer:z.string().max(512).optional(),reach:z.enum(["all","project","device","branch","branch_device"]).optional(),owner:z.enum(["self","peer","any"]).optional()}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.history"),root:rootSchema,id:z.string().min(1).max(256),category:z.enum(["candidate","promoted"]),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  ...(["memory.handbook","memory.topics.suggest"] as const).map(action=>z.object({version:z.literal(1),action:z.literal(action),root:rootSchema,reach:z.enum(["all","project","device","branch","branch_device"]).optional(),owner:z.enum(["self","peer","any"]).optional()}).strict()),
  z.object({version:z.literal(1),action:z.literal("memory.topic.page"),root:rootSchema,id:z.string().min(1).max(256),reach:z.enum(["all","project","device","branch","branch_device"]).optional(),owner:z.enum(["self","peer","any"]).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.topic.save"),root:rootSchema,id:z.string().min(1).max(256).optional(),layer:z.string().max(512).optional(),name:z.string().trim().min(1).max(200),introduction:z.string().max(20000).optional(),prefixes:z.array(z.string().max(512)).max(100),expectedRevisions:z.array(z.string().max(256)).max(100).optional(),deleted:z.boolean().optional()}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.topic.membership"),root:rootSchema,topicId:z.string().min(1).max(256),memoryId:z.string().min(1).max(256),mode:z.enum(["include","exclude","default"])}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.export"),root:rootSchema,dryRun:z.boolean().optional(),force:z.boolean().optional()}).strict(),
  ...rulesRequestSchemas,
  z.object({ version: z.literal(1), action: z.literal("account.status") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.summary") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.logout") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.bootstrap") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.enrollment.poll") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.devices") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.secrets.review") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.capabilities"), server: accountServerSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.challenge"), server: accountServerSchema, email: accountEmailSchema, purpose: z.enum(["register", "login", "reset"]) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.verify"), server: accountServerSchema, email: accountEmailSchema, challengeId: z.string().uuid(), code: accountCodeSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.register"), server: accountServerSchema, email: accountEmailSchema, challengeId: z.string().uuid(), code: accountCodeSchema, password: accountPasswordSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.password.login"), server: accountServerSchema, email: accountEmailSchema, password: accountPasswordSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.password.set"), password: accountPasswordSchema, currentPassword: accountPasswordSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.password.reset.verify"), server: accountServerSchema, challengeId: z.string().uuid(), code: accountCodeSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.password.reset.complete"), server: accountServerSchema, resetToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: accountPasswordSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.passkey.start"), server: accountServerSchema, kind: z.enum(["login", "add"]), redirectUri: z.string().max(150), label: accountLabelSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.passkey.exchange"), server: accountServerSchema, kind: z.enum(["login", "add"]), code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state: z.string().regex(/^[A-Za-z0-9_-]{43}(?:_\d{1,20})?$/) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.passkeys") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.passkey.remove"), id: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.vault.prepare"), filePath: rootSchema, label: accountLabelSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.vault.confirm"), filePath: rootSchema, code: recoveryCodeSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.device.request"), label: accountLabelSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.device.approve"), fingerprint: fingerprintSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.device.revoke"), deviceId: z.string().uuid(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.device.complete"), requestId: z.string().uuid(), fingerprint: fingerprintSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.device.cancel"), requestId: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("account.recovery.restore"), filePath: rootSchema, code: recoveryCodeSchema, label: accountLabelSchema.optional() }).strict(),
  z.object({version:z.literal(2),action:z.literal("memory.freshness"),root:rootSchema}).strict(),
  z.object({ version: z.literal(1), action: z.literal("projects.list") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("watcher.status") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("watcher.install") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("watcher.runtime-details") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("projects.inspect"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("projects.add"), root: rootSchema, initialize: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("projects.remove"), root: rootSchema, mode: z.enum(["list", "local", "everywhere"]).optional(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.overview"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.sources"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.sources.check"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.clients.status"), root: rootSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.clients.connect"), client: z.enum(["claude", "codex"]) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.settings.read"), root: rootSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.settings.save"), root: rootSchema.optional(), settings: aiSettingsSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.connection.setKey"), root: rootSchema.optional(), connectionId: aiIdSchema, key: z.string().min(1).max(4096), saveToEnv: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.connection.removeKey"), root: rootSchema.optional(), connectionId: aiIdSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.connection.test"), connectionId: aiIdSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("ai.models.list"), connectionId: aiIdSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("update.check") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("update.download"), updateVersion: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.sync.status"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.projects.list"), refresh: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.project.inspect"), root: rootSchema, refresh: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.project.link"), root: rootSchema, projectId: z.string().uuid(), approveRemote: z.boolean().optional(), confirmed: z.boolean().optional(), confirmation: z.object({ review: linkReviewSchema, typedProjectId: z.string().uuid() }).strict().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.project.link-review"), root: rootSchema, projectId: z.string().uuid(), intent: z.enum(["recover", "share-remote"]) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.connection.repair"), root: rootSchema, key: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.project.make-portable"), root: rootSchema, approveRemote: z.boolean().optional(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.project.separate"), root: rootSchema, confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.sync.review"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.sync.resolve"), root: rootSchema, choice: z.enum(["local", "cloud", "merge"]), confirmed: z.boolean().optional(), review: z.object({ projectId: z.string().uuid(), localFingerprint: z.string().regex(/^[a-f0-9]{64}$/), remote: z.object({ revision: z.number().int().positive(), commitment: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), canMerge: z.boolean(), firstConnection: z.boolean().optional(), localSummary: z.object({ memories: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(), sources: z.number().int().nonnegative() }).strict().optional(), cloudSummary: z.object({ memories: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(), sources: z.number().int().nonnegative() }).strict().optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.operation.status"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.operation.release-intent"), root: rootSchema, intentId: intentIdSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("project.summary.refresh"), root: rootSchema, force: z.boolean().optional() }).strict(),
  z.object({
    version: z.literal(1),
    action: z.literal("memory.search"),
    root: rootSchema,
    query: z.string().trim().max(500),
    qualityStatus: z.enum(["active", "needs_review", "quarantined", "all"]).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    limit: z.number().int().min(1).max(51).optional()
  }).strict(),
  z.object({version:z.literal(2),action:z.literal("memory.page"),root:rootSchema,query:z.string().trim().max(500).optional(),
    tier:z.enum(["working","candidates","durable","verified"]).optional(), qualityStatus:z.enum(["active","needs_review","quarantined","all"]).optional(),
    history:z.boolean().optional(),verifiedOnly:z.boolean().optional(),reach:z.enum(["all","project","device","branch","branch_device"]).optional(),
    owner:z.enum(["self","peer","any"]).optional(),type:z.enum(["decision","constraint","bug_fix","rejected_approach"]).optional(),
    limit:z.number().int().min(1).max(100).optional(),cursor:z.string().max(4096).optional()}).strict(),
  z.object({version:z.literal(2),action:z.literal("memory.tiers"),root:rootSchema}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.working.detail"),root:rootSchema,id:z.string().min(1).max(256)}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.working.keep"),root:rootSchema,id:z.string().min(1).max(256)}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.working.candidate"),root:rootSchema,id:z.string().min(1).max(256),
    type:z.enum(["decision","constraint","bug_fix","rejected_approach"]),text:z.string().trim().min(1).max(20000),
    title:z.string().trim().min(1).max(500).optional(),reason:z.string().trim().min(1).max(10000).optional(),
    fields:memoryStatementFieldsSchema.optional(),destination:z.enum(["project","device","branch"])}).strict(),
  z.object({version:z.literal(1),action:z.literal("memory.promote-project"),root:rootSchema,id:z.string().min(1).max(256),
    category:z.enum(["candidate","promoted"]),reason:z.string().trim().min(1).max(10000)}).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.detail"), root: rootSchema, id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.ai.preview"), root: rootSchema, mode:z.enum(["reconcile","wording"]).optional(), selection: aiSelectionSchema, intentId: intentIdSchema.optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.ai.status"), root: rootSchema,mode:z.enum(["reconcile","wording"]).optional(), runId: z.string().min(1).max(256).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.ai.results"), root: rootSchema,mode:z.enum(["reconcile","wording"]).optional(), runId: z.string().min(1).max(256) }).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.ai.apply"), root: rootSchema,mode:z.enum(["reconcile","wording"]).optional(), runId: z.string().min(1).max(256), itemIds: z.array(z.string().min(1).max(512)).min(1).max(100_000), applyCorrections: z.boolean().optional(), forceOffline: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("memory.ai.revert"), root: rootSchema,mode:z.enum(["reconcile","wording"]).optional(), runId: z.string().min(1).max(256), forceOffline: z.boolean().optional() }).strict(),
  z.object({
    version: z.literal(1),
    action: z.literal("memory.review.resolve"),
    root: rootSchema,
    memoryId: z.string().trim().min(1).max(256),
    category: z.enum(["candidate", "promoted"]),
    reviewAction: z.enum(["verify", "correct", "discard"]),
    reason: z.string().trim().min(1).max(10_000).optional(),
    reviewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    correction: z.object({
      type: z.enum(["decision", "bug_fix", "constraint", "rejected_approach"]).optional(),
      title: z.string().trim().min(1).max(500).optional(),
      text: z.string().trim().min(1).max(100_000).optional(),
      summary: z.string().trim().min(1).max(100_000).optional(),
      reason: z.string().trim().min(1).max(10_000).optional(),
      relatedFiles: z.array(z.string().trim().min(1).max(32_767)).max(1_000).optional(),
      scope: memoryScopeSchema.optional(),
      statement: memoryStatementSchema.optional()
    }).strict().optional()
  }).strict(),
  z.object({ version: z.literal(1), action: z.literal("cloud.sync.set-enabled"), root: rootSchema, enabled: z.boolean(), confirmed: z.boolean().optional(), createNew: z.boolean().optional(), approveRemote: z.boolean().optional(), projectId: z.string().uuid().optional(), confirmation: z.object({ review: linkReviewSchema, typedProjectId: z.string().uuid() }).strict().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.sync.status"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.sync.now"), root: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.sync.set-enabled"), root: rootSchema, enabled: z.boolean(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.sync.link"), root: rootSchema, vaultId: z.string().uuid(), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.sync.resolve"), root: rootSchema, path: z.string().min(1).max(1024), choice: z.enum(["local", "remote"]), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.recovery.prepare"), root: rootSchema, filePath: rootSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.recovery.confirm"), root: rootSchema, filePath: rootSchema, code: recoveryCodeSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.recovery.restore"), root: rootSchema, filePath: rootSchema, code: recoveryCodeSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.request") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.complete") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.vaults") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.devices") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.status") }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.approve"), code: z.string().min(1).max(16_000), confirmed: z.boolean().optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("secrets.access.revoke"), deviceId: z.string().uuid(), confirmed: z.boolean().optional() }).strict()
]);

export class DesktopServiceError extends Error {
  constructor(
    readonly code: "invalid-request" | "confirmation-required" | "not-registered" | "not-found" | "stale-review" | "stale-rule" | "busy" | "internal",
    message: string
  ) {
    super(message);
  }
}

export interface DesktopServiceOptions extends RulesDesktopDependencies {
  watcherServiceStatus?: () => DesktopWatcherStatus;
  initializeProject?: typeof initializeProjectMemory;
  initializationOptions?: ProjectSummaryOperationOptions;
  projectSummaryOptions?: ProjectSummaryOperationOptions;
  ensureGlobalWatcher?: () => void;
  removeCloudProject?: Parameters<typeof removeDesktopProject>[2];
  setCloudSyncEnabled?: typeof setEncryptedCloudSyncEnabled;
  automaticConnection?: AutomaticConnectionOptions;
  bootstrapAccount?: typeof bootstrapAccount;
}

export async function handleDesktopRequest(input: unknown, options: DesktopServiceOptions = {}): Promise<DesktopResult> {
  let request: DesktopRequest;
  try {
    request = requestSchema.parse(input) as DesktopRequest;
  } catch (error) {
    throw new DesktopServiceError("invalid-request", error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid request" : "Invalid request");
  }

  try { switch (request.action) {
    case "account.status": return localAccountStatus();
    case "account.summary": return accountSummary();
    case "account.bootstrap": return bootstrapDesktopAccount(options, true);
    case "account.devices": return accountDevices();
    case "account.secrets.review": return (await import("../secrets/migration.js")).listLegacySecretsReview();
    case "account.device.revoke":
      if (!request.confirmed) throw new DesktopServiceError("confirmation-required", "Confirm removal of this device and its encrypted cloud access first.");
      return accountDeviceRevoke(request.deviceId);
    case "account.enrollment.poll": {
      const result = await enrollmentPoll();
      if (result.status === "enrolled") await bootstrapDesktopAccount(options, true);
      return result;
    }
    case "account.logout": return accountLogout();
    case "account.capabilities": return accountCapabilities(request.server);
    case "account.challenge": return accountChallenge(request.server, request.email, request.purpose);
    case "account.verify": { const status = await accountVerify(request.server, request.email, request.challengeId, request.code); await bootstrapDesktopAccount(options, true, status); return status; }
    case "account.register": { const status = await accountRegister(request.server, request.email, request.challengeId, request.code, request.password); await bootstrapDesktopAccount(options, true, status); return status; }
    case "account.password.login": { const status = await accountPasswordLogin(request.server, request.email, request.password); await bootstrapDesktopAccount(options, true, status); return status; }
    case "account.password.set": return accountSetPassword(request.password, request.currentPassword);
    case "account.password.reset.verify": return accountResetVerify(request.server, request.challengeId, request.code);
    case "account.password.reset.complete": return accountResetComplete(request.server, request.resetToken, request.password);
    case "account.passkey.start": return accountPasskeyStart(request.server, request.kind, request.redirectUri, request.label);
    case "account.passkey.exchange": { const status = await accountPasskeyExchange(request.server, request.kind, request.code, request.verifier, request.state); await bootstrapDesktopAccount(options, true, status); return status; }
    case "account.passkeys": return accountPasskeys();
    case "account.passkey.remove": return accountPasskeyRemove(request.id);
    case "account.vault.prepare": return vaultPrepare(request.filePath, request.label);
    case "account.vault.confirm": { const result = await vaultConfirm(request.filePath, request.code); await bootstrapDesktopAccount(options, true); return result; }
    case "account.device.request": return deviceRequest(request.label);
    case "account.device.approve": return deviceApprove(request.fingerprint);
    case "account.device.complete": { const result = await deviceComplete(request.requestId, request.fingerprint); await bootstrapDesktopAccount(options, true); return result; }
    case "account.device.cancel": { const result = await deviceCancel(request.requestId); if (result.status === "enrolled") await bootstrapDesktopAccount(options, true); return result; }
    case "account.recovery.restore": { const result = await recoveryRestore(request.filePath, request.code, request.label); await bootstrapDesktopAccount(options, true); return result; }
    case "rules.assistance.status": case "rules.draft": case "rules.list": case "rules.create": case "rules.update": case "rules.delete": case "rules.set-enabled": case "rules.resolve-conflict": case "rules.sync.status": case "rules.sync.set-enabled": case "rules.sync.now":
      if (request.action === "rules.sync.set-enabled" && !request.confirmed) throw new DesktopServiceError("confirmation-required", "Confirm the cloud sync change first.");
      try {
        const result = await handleRulesDesktopRequest(request, options);
        if (request.action === "rules.sync.set-enabled" && request.enabled) (options.ensureGlobalWatcher ?? ensureDesktopGlobalWatcher)();
        return result;
      }
      catch (error) { throw new DesktopServiceError(error instanceof StaleRuleError ? "stale-rule" : "invalid-request", error instanceof Error ? error.message : "Global rules operation failed"); }
    case "projects.list":
      return listProjects(options);
    case "watcher.status": {
      const status = globalWatchStatus();
      return options.watcherServiceStatus?.() ?? watcherServiceStatus(status.running, status.pid, status.build);
    }
    case "watcher.install": {
      // The same per-user watcher Add Project installs; a no-op when it is already installed.
      try { (options.ensureGlobalWatcher ?? ensureDesktopGlobalWatcher)(); }
      catch (error) { throw new DesktopServiceError("invalid-request", `The shared watcher could not be installed: ${error instanceof Error ? error.message : "unknown error"}`); }
      const status = globalWatchStatus();
      return options.watcherServiceStatus?.() ?? watcherServiceStatus(status.running, status.pid, status.build);
    }
    case "watcher.runtime-details":
      return { processes: runtimeDiagnostics() };
    case "projects.inspect":
      return inspectDesktopProject(validProjectRoot(request.root));
    case "projects.add":
      return addProject(request.root, request.initialize === true, options);
    case "projects.remove": {
      const project = requireRegisteredProject(request.root, true);
      const mode = request.mode ?? "list";
      if (mode !== "list" && request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm deletion of this project's memory first.");
      try { await removeDesktopProject(project.root, mode, options.removeCloudProject); }
      catch (error) { throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "Project removal failed."); }
      return desktopProject(project);
    }
    case "project.overview":
      return projectOverview(requireRegisteredProject(request.root));
    case "project.sources":
      return canonicalDesktopRead(requireRegisteredProject(request.root).root, store => ({
        byType: store.countSourcesByType(),
        adapters: store.listSyncStatuses().map(({ metadata: _metadata, ...status }) => status),
        failures: store.listSourceFailures({ resolved: false, limit: 20 })
      }));
    case "project.sources.check":
      return checkProjectSources(requireRegisteredProject(request.root).root);
    case "ai.clients.status":
      return aiClientStatus(request.root ? { root: requireRegisteredProject(request.root).root } : {});
    case "ai.settings.read":
      return readAiSettings(request.root ? requireRegisteredProject(request.root).root : undefined);
    case "ai.settings.save":
      return aiSettingsAction(() => saveAiSettings(request.settings as AiSettings, request.root ? requireRegisteredProject(request.root).root : undefined));
    case "ai.connection.setKey":
      return aiSettingsAction(() => setConnectionKey(request.connectionId, request.key, request.saveToEnv === true, request.root ? requireRegisteredProject(request.root).root : undefined));
    case "ai.connection.removeKey":
      return aiSettingsAction(() => removeConnectionKey(request.connectionId, request.root ? requireRegisteredProject(request.root).root : undefined));
    case "ai.connection.test":
      return aiSettingsAction(() => testConnection(request.connectionId));
    case "update.check":
      return aiSettingsAction(() => checkForUpdate());
    case "update.download":
      return aiSettingsAction(() => downloadUpdate(request.updateVersion));
    case "ai.models.list":
      return aiSettingsAction(() => listConnectionModels(request.connectionId));
    case "ai.clients.connect":
      try { return connectAiClient(request.client); }
      catch (error) { throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "The connection could not be set up."); }
    case "cloud.sync.status": {
      const project = requireRegisteredProject(request.root);
      return cloudStatusForProject(project);
    }
    case "project.operation.status": {
      const root = requireRegisteredProject(request.root).root;
      // Uploads hold only the checkout's cloud gate, so fall back to it when the project gate is free.
      const cloudOperation = readProjectOperationStatus(stateDirectory(root));
      const operation = readProjectOperationStatus(root) ?? cloudOperation;
      if (!operation) return {};
      const progress = cloudOperation ? readSyncProgress(root) : undefined;
      return { operation: progress ? { ...operation, progress } : operation };
    }
    case "project.operation.release-intent":
      releaseForegroundIntent(requireRegisteredProject(request.root).root, request.intentId);
      return { released: true };
    case "project.summary.refresh":
      return refreshProjectNarrative(requireRegisteredProject(request.root), request.force === true, options.projectSummaryOptions);
    case "memory.search":
      return searchMemories(requireRegisteredProject(request.root), request.query, request.qualityStatus ?? "all", request.offset ?? 0, request.limit ?? 20);
    case "memory.tiers": {
      const project=requireRegisteredProject(request.root);
      if(!retrievalEnabled())return canonicalDesktopRead(project.root,store=>{const page=readCanonicalTierPage(store,{limit:1});return {counts:page.counts,movement7d:page.movement7d,freshness:page.freshness};});
      scheduleRetrieval(project.root);return readPublishedTiers(project.root);
    }
    case "memory.page": {
      const project=requireRegisteredProject(request.root);
      if(!retrievalEnabled() && request.tier)return canonicalDesktopRead(project.root,store=>{
        const {root:_root,version:_version,action:_action,...input}=request;
        const page=readCanonicalTierPage(store,input);
        return {...page,items:page.items.map(m=>"qualityStatus" in m ? desktopMemory(store,m as MemorySearchResult) : m)};
      });
      scheduleRetrieval(project.root);
      return withPublishedIndex(project.root,()=>{
        if (request.tier) {
          const {root:_root,version:_version,action:_action,...input}=request;
          const page=readPublishedTierPage(project.root,input);
          return {...page,items:page.items.map(m => "qualityStatus" in m ? publishedDesktopMemory(project.root,m as MemorySearchResult) : m)};
        }
        const page=readPublishedMemories(project.root,{query:request.query ?? "",qualityStatus:request.qualityStatus ?? "all",lifecycleStatus:"all",owner:"any",layer:"all",summaryOnly:true,limit:request.limit ?? 50,...(request.cursor ? {cursor:request.cursor} : {})});
        return {...page,items:page.items.map(memory=>publishedDesktopMemory(project.root,memory))};
      });
    }
    case "memory.freshness": {
      const project=requireRegisteredProject(request.root);
      if(!retrievalEnabled())return canonicalDesktopRead(project.root,store=>({freshness:readCanonicalFreshness(store)}));
      scheduleRetrieval(project.root);return {freshness:readPublishedTiers(project.root).freshness};
    }
    case "memory.detail":
      return memoryDetail(requireRegisteredProject(request.root), request.id);
    case "memory.history": return desktopKnowledgeRead(requireRegisteredProject(request.root).root,data=>memoryHistory(data,request.id,request.category,request));
    case "memory.handbook": return desktopKnowledgeRead(requireRegisteredProject(request.root).root,data=>readHandbook(data,{reach:request.reach??"project",owner:request.owner}));
    case "memory.topics.suggest": return desktopKnowledgeRead(requireRegisteredProject(request.root).root,data=>suggestHandbookTopics(data,{reach:request.reach??"project",owner:request.owner}));
    case "memory.topic.page": return desktopKnowledgeRead(requireRegisteredProject(request.root).root,data=>readHandbookTopic(data,request.id,{reach:request.reach??"project",owner:request.owner},request.offset,request.limit));
    case "memory.topic.preview": return desktopKnowledgeRead(requireRegisteredProject(request.root).root,data=>previewHandbookTopic(data,request.prefixes,{reach:request.reach??"project",owner:request.owner,layer:request.layer}));
    case "memory.topic.save": return desktopKnowledgeMutation(requireRegisteredProject(request.root).root,store=>saveMemoryTopic(store,request));
    case "memory.topic.membership": return desktopKnowledgeMutation(requireRegisteredProject(request.root).root,store=>setTopicMembership(store,request));
    case "memory.export": return canonicalDesktopRead(requireRegisteredProject(request.root).root,store=>exportMemoryHandbook(store,request));
    case "memory.working.detail": {
      const project=requireRegisteredProject(request.root);
      if(!retrievalEnabled())return canonicalDesktopRead(project.root,store=>{
        const memory=store.readTemporaryMemory(request.id);
        if(!memory || memory.expiresAt<=new Date().toISOString())throw new DesktopServiceError("not-found","Working context has expired or is unavailable");
        return {...memory,peer:isPeerLayer(store,memory.layer),sharing:sharingLabel(memory.layer,isPeerLayer(store,memory.layer))};
      });
      scheduleRetrieval(project.root);
      const memory=readPublishedWorkingDetail(project.root,request.id);
      if (!memory) throw new DesktopServiceError("not-found","Working context has expired or is unavailable");
      return memory;
    }
    case "memory.working.keep":
    case "memory.working.candidate":
    case "memory.promote-project": {
      const root=requireRegisteredProject(request.root).root;
      try {
        const result=await projectOperation(root,()=>{
          const store=openConfiguredMemoryStore(root);store.init();
          try {
            if (request.action==="memory.working.keep") return store.keepTemporaryMemory(request.id);
            if (request.action==="memory.working.candidate") return createWorkingCandidate(store,request);
            return updateMemoryLayer(store,{memoryId:request.id,category:request.category,layer:"core",reason:request.reason},"desktop");
          } finally {store.close();}
        });
        if(retrievalEnabled()) scheduleRetrieval(root);return result;
      } catch(error) {throw new DesktopServiceError("invalid-request",error instanceof Error ? error.message : "Memory change could not be saved");}
    }
    case "memory.review.resolve":
      return resolveDesktopMemoryReview(requireRegisteredProject(request.root), request);
    case "memory.ai.preview": {
      const root = requireRegisteredProject(request.root).root;
      if (request.intentId) renewForegroundIntent(root, request.intentId);
      try {
        if(request.mode==="wording") {
          if(request.selection.kind!=="selected"&&request.selection.kind!=="single")throw new Error("Choose explicit wording memories");
          const preview = previewMemoryWording(root,request.selection);
          if (request.intentId) releaseForegroundIntent(root, request.intentId);
          return preview;
        }
        if((request.selection as {kind:string}).kind==="selected")throw new Error("Selected batches require wording mode");
        const preview = previewDesktopMemoryReconciliation(root, request.selection);
        if (request.intentId) releaseForegroundIntent(root, request.intentId);
        return preview;
      } catch (error) {
        if (!(error instanceof OperationDeferredError) && request.intentId) releaseForegroundIntent(root, request.intentId);
        throw desktopAiError(error, "Could not prepare AI review");
      }
    }
    case "memory.ai.status": {
      try {
        const root = requireRegisteredProject(request.root).root;
        const run = request.mode==="wording" ? readMemoryWording(root,request.runId) : readDesktopMemoryReconciliationStatus(root, request.runId);
        return run ? { run } : {};
      } catch (error) { throw desktopAiError(error, "Could not load saved AI review status"); }
    }
    case "memory.ai.results": {
      try {
        const root = requireRegisteredProject(request.root).root;
        if (request.mode === "wording") return await projectOperation(root, () => {
          const run = readMemoryWording(root, request.runId);
          if (!run) throw new Error("Unknown wording run");
          return { run, citations: {}, memories: {} };
        });
        const { run, citations } = readDesktopMemoryReconciliationResults(root, request.runId);
        let memories: Record<string, { title: string; summary: string }> | undefined;
        try {
          // Titles live in the shared database, so take them only if the project is free right now.
          memories = await projectOperation(root, () => {
            const store = openConfiguredMemoryStore(root);
            store.init();
            try {
              const found = store.readMemorySearchResultsByIds(run.items.map((item) => item.memoryId), { lifecycleStatus: "all", includeCandidates: true });
              return Object.fromEntries(found.map((memory) => [memory.id, { title: memory.title, summary: memory.summary }]));
            } finally { store.close(); }
          }, { waitMs: 0, name: "Load AI review titles" });
        } catch (error) { if (!(error instanceof OperationDeferredError)) throw error; }
        return { run, citations, memories: memories ?? {}, ...(memories ? {} : { memoriesPending: true }) };
      } catch (error) { throw desktopAiError(error, "Could not load AI review results"); }
    }
    case "memory.ai.apply": {
      const root = requireRegisteredProject(request.root).root;
      const intent = beginForegroundIntent(root);
      try {
        return request.mode==="wording" ? await applyMemoryWording(root,request.runId,request.itemIds) : await applyMemoryReconciliation(root, { runId: request.runId, itemIds: request.itemIds, applyCorrections: request.applyCorrections, forceOffline: request.forceOffline });
      } catch (error) { throw desktopAiError(error); }
      finally { intent.release(); }
    }
    case "memory.ai.revert": {
      const root = requireRegisteredProject(request.root).root;
      const intent = beginForegroundIntent(root);
      try { if(request.mode==="wording"){const run=readMemoryWording(root,request.runId);if(!run)throw new Error("Unknown wording run");return await applyMemoryWording(root,run.id,run.items.filter(i=>i.state==="applied").map(i=>i.itemId),true);}return await revertMemoryReconciliation(root, { runId: request.runId, forceOffline: request.forceOffline }); }
      catch (error) { throw desktopAiError(error); }
      finally { intent.release(); }
    }
    case "cloud.projects.list": return cloudProjectList(request.refresh);
    case "cloud.project.inspect": return inspectProjectConnection(requireRegisteredProject(request.root).root, request.refresh);
    case "cloud.project.link-review": {
      try { return await reviewProjectLink(requireRegisteredProject(request.root).root, request.projectId, request.intent, selectedCloudClient()); }
      catch (error) { if (error instanceof DesktopServiceError) throw error; throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "Cloud memory could not be verified for recovery."); }
    }
    case "cloud.connection.repair": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Review and select the intended saved connection first.");
      const project = requireRegisteredProject(request.root), intent = beginForegroundIntent(project.root);
      try {
        await withProjectGate(project.root, () => migrateCheckout(project.root, { key: request.key, fingerprint: request.fingerprint }), { name: "Restore saved checkout connection" });
        const state = binding(project.root);
        if (state) recordWatchedCloudConnection(project.root, state);
        if (state?.enabled) requestAutomaticSync(project.root);
        return cloudStatusForProject(project, state);
      } catch (error) { throw new DesktopServiceError("stale-review", error instanceof Error ? error.message : "Reload the connection repair review."); }
      finally { intent.release(); }
    }
    case "cloud.sync.review": return reviewProjectConflict(requireRegisteredProject(request.root).root);
    case "cloud.project.link": case "cloud.project.make-portable": case "cloud.project.separate": case "cloud.sync.resolve": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Choose and confirm the connection action first.");
      const project = requireRegisteredProject(request.root), intent = beginForegroundIntent(project.root);
      try {
        if (request.action === "cloud.project.separate") return await separateProjectIdentity(project.root);
        if (request.action === "cloud.sync.resolve") return cloudStatusForProject(project, await resolveProjectConflict(project.root, request.choice, request.review));
        const cloud = request.action === "cloud.project.link"
          ? await connectCloudProject(project.root, { projectId: request.projectId, approveRemote: request.approveRemote ?? false, ...(!binding(project.root) ? { enabled: true } : {}), ...(request.confirmation ? { confirmation: request.confirmation } : {}) })
          : await makeProjectPortable(project.root, request.approveRemote);
        return cloudStatusForProject(project, cloud);
      } catch (error) { throw new DesktopServiceError(error instanceof Error && /changed since the review/.test(error.message) ? "stale-review" : "invalid-request", error instanceof Error ? error.message : "Cloud connection could not be updated."); }
      finally { intent.release(); }
    }
    case "cloud.sync.set-enabled": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm the cloud sync change first.");
      const project = requireRegisteredProject(request.root), intent = beginForegroundIntent(project.root);
      try {
        if (!request.enabled) pauseAutomaticConnection(project.root);
        const cloud = await (options.setCloudSyncEnabled ?? setEncryptedCloudSyncEnabled)(project.root, request.enabled, {
          ...(request.createNew !== undefined ? { createNew: request.createNew } : {}),
          ...(request.approveRemote !== undefined ? { approveRemote: request.approveRemote } : {}),
          ...(request.projectId ? { projectId: request.projectId } : {}),
          ...(request.confirmation ? { confirmation: request.confirmation } : {})
        });
        return cloudStatusForProject(project, cloud);
      } catch (error) {
        throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "Cloud sync could not be updated.");
      }
      finally { intent.release(); }
    }
    case "secrets.sync.status": return secretsSyncStatus(requireRegisteredProject(request.root).root);
    case "secrets.sync.now": return encryptedSecretsSync(requireRegisteredProject(request.root).root);
    case "secrets.sync.set-enabled": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm the secrets sync change first.");
      return setSecretsSyncEnabled(requireRegisteredProject(request.root).root, request.enabled);
    }
    case "secrets.sync.link": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm the project link first.");
      return linkSecretsVault(requireRegisteredProject(request.root).root, request.vaultId);
    }
    case "secrets.sync.resolve": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm the secret file conflict choice first.");
      return resolveSecretsConflict(requireRegisteredProject(request.root).root, request.path, request.choice);
    }
    case "secrets.recovery.prepare": return prepareSecretsRecovery(requireRegisteredProject(request.root).root, request.filePath);
    case "secrets.recovery.confirm": return confirmSecretsRecovery(requireRegisteredProject(request.root).root, request.filePath, request.code);
    case "secrets.recovery.restore": {
      await restoreSecretsProject(requireRegisteredProject(request.root).root, request.filePath, request.code);
      return secretsSyncStatus(request.root);
    }
    case "secrets.access.request": return requestAllSecretsAccess();
    case "secrets.access.vaults": return listSecretsVaults();
    case "secrets.access.devices": return listSecretsDevices();
    case "secrets.access.status": return secretsAccessStatus();
    case "secrets.access.approve": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm device approval first.");
      return approveAllSecretsAccess(request.code);
    }
    case "secrets.access.complete": return completeAllSecretsAccess();
    case "secrets.access.revoke": {
      if (request.confirmed !== true) throw new DesktopServiceError("confirmation-required", "Confirm device revocation first.");
      return revokeSecretsDevice(request.deviceId);
    }
  } } catch (error) {
    if (!request.action.startsWith("secrets.") || error instanceof DesktopServiceError) throw error;
    if (error instanceof OperationDeferredError) throw new DesktopServiceError("busy", "Another project operation is active. Retry shortly.");
    if (error instanceof EncryptionError) throw new DesktopServiceError("invalid-request", `Sensitive file operation failed: ${error.state}.`);
    const safe = error instanceof Error && [
      "Secret files are tracked by Git", "Keep the recovery file outside the project folder",
      "Choose a new recovery file path", "Choose an absolute recovery file path", "This project already has a secrets binding"
    ].some(prefix => error.message.startsWith(prefix));
    throw new DesktopServiceError("invalid-request", safe ? (error as Error).message : "Sensitive file operation failed. Check permissions, quota, and connection, then retry.");
  }
}

export async function runDesktopMemoryReview(
  input: unknown,
  onProgress: (progress: ReconciliationProgress) => void,
  shouldStop: () => boolean,
  dependencies: MemoryReconciliationDependencies & { onWaiting?: (status: { operation?: ProjectOperationStatus; elapsedMs: number }) => void } = {}
) {
  let request: z.infer<typeof aiRunSchema>;
  try { request = aiRunSchema.parse(input); }
  catch (error) {
    const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
    throw new DesktopServiceError("invalid-request", `Invalid AI review Start request: ${issue?.path.join(".") || "request"} ${issue?.message ?? "could not be validated"}`);
  }
  const root = requireRegisteredProject(request.root).root;
  const intent = beginForegroundIntent(root);
  const callbacks = { ...dependencies, onProgress, shouldStop, onPrepared: () => { intent.release(); dependencies.onPrepared?.(); } };
  try {
  if(request.mode==="wording") {
    if(request.selection&&request.selection.kind!=="single"&&request.selection.kind!=="selected")throw new Error("Choose explicit wording memories");
    return await waitForReviewAccess(root,shouldStop,dependencies.onWaiting,()=>runMemoryWording(root,{...request,selection:request.selection as WordingSelection|undefined},callbacks));
  }
  if (request.continueRunId) {
    try { return await waitForReviewAccess(root, shouldStop, dependencies.onWaiting, () => continueDesktopMemoryReconciliation(root, request.continueRunId!, request.tokenCap, callbacks)); }
    catch (error) { if (error instanceof ReviewStartCancelledError) throw error; throw desktopAiError(error, "Could not continue AI review"); }
  }
  const selection = request.selection!;
  if(selection.kind==="selected")throw new Error("Selected batches require wording mode");
  let preview;
  try { preview = await waitForReviewAccess(root, shouldStop, dependencies.onWaiting, () => previewDesktopMemoryReconciliation(root, selection, callbacks, request.expectedSelectionFingerprint)); }
  catch (error) { if (error instanceof ReviewStartCancelledError) throw error; throw desktopAiError(error, "Could not prepare AI review Start"); }
  if (preview.selected === 0) throw new DesktopServiceError("invalid-request", "No eligible memories are available for this review.");
  try { return await waitForReviewAccess(root, shouldStop, dependencies.onWaiting, () => planMemoryReconciliation(root, {
    queue: "all",
    desktopSelection: selection,
    expectedSelectionFingerprint: request.expectedSelectionFingerprint,
    limit: selection.kind === "single" ? null : selection.limit,
    maxRequests: Math.max(1, preview.modelItems * 2),
    tokenBudget: request.tokenCap,
    concurrency: 2
  }, callbacks)); }
  catch (error) { if (error instanceof ReviewStartCancelledError) throw error; throw desktopAiError(error, "Could not start AI review"); }
  } finally { intent.release(); }
}

export class ReviewStartCancelledError extends Error {
  constructor() { super("AI review start cancelled."); this.name = "ReviewStartCancelledError"; }
}

async function waitForReviewAccess<T>(
  root: string,
  shouldStop: () => boolean,
  onWaiting: ((status: { operation?: ProjectOperationStatus; elapsedMs: number }) => void) | undefined,
  work: () => Promise<T> | T
): Promise<T> {
  const started = Date.now();
  while (true) {
    if (shouldStop()) throw new ReviewStartCancelledError();
    try { return await work(); }
    catch (error) {
      if (!(error instanceof OperationDeferredError)) throw error;
      const operation = readProjectOperationStatus(root);
      onWaiting?.({ ...(operation ? { operation } : {}), elapsedMs: Date.now() - started });
      await delay(750);
    }
  }
}

function desktopAiError(error: unknown, context = "AI review could not be completed"): DesktopServiceError {
  if (error instanceof DesktopServiceError) return error;
  if (error instanceof OperationDeferredError) return new DesktopServiceError("busy", `${context}: another local Code Butler operation is still active. Retry when it finishes.`);
  const diagnosticId = recordUnexpectedDesktopError(error, context);
  return new DesktopServiceError("invalid-request", `${context}: ${error instanceof Error ? error.message : "unexpected error"}${diagnosticId ? ` (diagnostic ${diagnosticId})` : ""}`);
}

function validProjectRoot(root: string): string {
  assertOrdinaryProject(root);
  let canonical: string;
  try {
    canonical = canonicalRoot(root);
    if (!statSync(canonical).isDirectory()) {
      throw new DesktopServiceError("invalid-request", "Choose a project folder, not a file.");
    }
  } catch (error) {
    if (error instanceof DesktopServiceError) throw error;
    throw new DesktopServiceError("not-found", "The selected folder is unavailable or cannot be opened.");
  }

  return canonical;
}

async function addProject(root: string, initialize: boolean, options: DesktopServiceOptions): Promise<DesktopProjectAddResult> {
  const canonical = validProjectRoot(root);
  // The gate stores its lock under .code-butler, so refuse unconfirmed setup
  // before entering it. Recheck inside the gate to catch a stale inspection.
  const initial = inspectDesktopProject(canonical);
  if (initial.status === "invalid") throw new DesktopServiceError("invalid-request", initial.issue ?? "Project setup is invalid.");
  if (initial.status === "busy") throw new DesktopServiceError("busy", initial.issue ?? "Project memory is busy.");
  if (initial.status !== "ready" && !initialize) {
    throw new DesktopServiceError("confirmation-required", "This folder needs initialization or an upgrade. Inspect it and confirm before adding it.");
  }
  clearProjectRemoved(canonical);
  const intent = beginForegroundIntent(canonical);
  try {
    const result = await projectOperation(canonical, async () => {
      const inspection: DesktopProjectInspection = inspectDesktopProject(canonical);
      if (inspection.status === "invalid") throw new DesktopServiceError("invalid-request", inspection.issue ?? "Project setup is invalid.");
      if (inspection.status === "busy") throw new DesktopServiceError("busy", inspection.issue ?? "Project memory is busy.");
      if (inspection.status !== "ready" && !initialize) {
        throw new DesktopServiceError("confirmation-required", "This folder needs initialization or an upgrade. Inspect it and confirm before adding it.");
      }
      const installed = inspection.status === "ready" ? undefined : await (options.initializeProject ?? initializeProjectMemory)(canonical, options.initializationOptions);
      const project = desktopProject(registerWatchedProject(canonical));
      const warnings = [...(installed?.warnings ?? [])];
      return {
        project,
        initialized: installed !== undefined,
        summaryFallback: installed?.fallback ?? false,
        backupFiles: installed?.backupFiles ?? [],
        warnings
      };
    });
    let cloudSetup = queueAutomaticConnection(canonical);
    if (cloudSetup.state === "pending") {
      let account;
      try { account = await localAccountStatus(); } catch { /* Offline native state leaves the portable connection pending. */ }
      const selected = account?.server && account.accountId ? { server: account.server, accountId: account.accountId } : undefined;
      cloudSetup = await retryAutomaticConnection(canonical, { ...options.automaticConnection, ready: Boolean(account?.signedIn && account.device === "enrolled"), ...(selected ? { account: selected } : {}), force: true });
    }
    try { (options.ensureGlobalWatcher ?? ensureDesktopGlobalWatcher)(); }
    catch (error) { result.warnings.push(`Project added, but the shared watcher could not be installed: ${error instanceof Error ? error.message : "unknown error"}`); }
    return { ...result, cloudSetup };
  } catch (error) {
    if (error instanceof DesktopServiceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new DesktopServiceError("invalid-request", "Code Butler cannot write to this folder. Choose a writable project folder.");
    }
    throw error;
  }
  finally { intent.release(); }
}

async function bootstrapDesktopAccount(options: DesktopServiceOptions, force = false, status?: Awaited<ReturnType<typeof localAccountStatus>>) {
  try {
    const automatic: AccountBootstrapOptions = { force, ...(options.automaticConnection ? { automaticConnection: options.automaticConnection } : {}), ...(options.setRulesSyncEnabled ? { setRulesSyncEnabled: options.setRulesSyncEnabled } : {}), ensureGlobalWatcher: options.ensureGlobalWatcher ?? ensureDesktopGlobalWatcher };
    return await (options.bootstrapAccount ?? bootstrapAccount)(status ?? await localAccountStatus(), automatic);
  } catch (error) {
    return { rules: { state: "pending" as const, reason: error instanceof Error ? error.message : "Automatic encrypted sync setup will retry." }, projects: [] };
  }
}

function ensureDesktopGlobalWatcher(): void {
  const cwd = globalConfigDir();
  const watchOptions = {
    cwd,
    global: true,
    cliPath: join(dirname(fileURLToPath(import.meta.url)), "watch.mjs"),
    nodePath: process.execPath
  };
  if (!getWatchServiceStatus(watchOptions).installed) installWatchService(watchOptions);
}

function listProjects(options: DesktopServiceOptions): DesktopProjectList {
  return {
    projects: listWatchedProjectStatuses().map(desktopProject),
    retrievalEngine: retrievalEnabled() ? "published" : "legacy",
    ...(options.watcherServiceStatus ? { watcher: options.watcherServiceStatus() } : {})
  };
}

function watcherServiceStatus(running: boolean, pid?: number, runnerBuild?: typeof buildInfo): DesktopWatcherStatus {
  const service = getWatchServiceStatus({ cwd: globalConfigDir(), global: true });
  return {
    build: runnerBuild ?? buildInfo,
    installed: service.installed,
    running,
    platform: service.platform,
    label: service.label,
    logsDir: service.logsDir,
    ...(pid === undefined ? {} : { pid })
  };
}

function desktopProject(project: WatchedProject & { lastRun?: DesktopProject["lastRun"]; lastCloudRun?: DesktopProject["lastCloudRun"] }): DesktopProject {
  return {
    root: project.root,
    registeredAt: project.registeredAt,
    name: basename(project.root),
    available: existsSync(join(project.root, ".code-butler", "config.json")),
    ...(project.lastRun === undefined ? {} : { lastRun: project.lastRun }),
    ...(project.lastCloudRun === undefined ? {} : { lastCloudRun: project.lastCloudRun })
  };
}

/** Consecutive failed cloud runs before the desktop reports the sync as failing rather than retrying. */
const FAILING_SYNC_RETRIES = 3;

function cloudStatusForProject(project: WatchedProject & { lastRun?: DesktopProject["lastRun"]; lastCloudRun?: DesktopProject["lastCloudRun"] }, cloud: Binding | undefined = binding(project.root)) {
  const sync = automaticSyncStatus(project.root);
  const latest = [project.lastCloudRun, project.lastRun].filter(run => run?.stage === "cloud")
    .sort((a, b) => b!.checkedAt.localeCompare(a!.checkedAt))[0];
  const sinceCompleted = !!latest && (!sync.lastCompletedAt || latest.checkedAt > sync.lastCompletedAt);
  const deferredReason = sync.pending && latest?.outcome === "deferred" && sinceCompleted ? latest.error : undefined;
  // One failed attempt is usually a dropped connection that the next retry recovers from; repeated ones are not.
  const failedReason = latest?.outcome === "failed" && sinceCompleted && (latest.retryCount ?? 0) >= FAILING_SYNC_RETRIES
    ? latest.error ?? "The last cloud sync failed." : undefined;
  return desktopCloudStatus(cloud, sync, deferredReason, failedReason);
}

function requireRegisteredProject(root: string, allowUnavailable = false): WatchedProject & { lastRun?: DesktopProject["lastRun"]; lastCloudRun?: DesktopProject["lastCloudRun"] } {
  let canonical: string;
  try {
    canonical = canonicalRoot(root);
  } catch {
    if (!allowUnavailable) throw new DesktopServiceError("not-found", "The project folder is unavailable.");
    canonical = resolve(root);
  }
  const project = globalWatchStatus().projects.find(candidate => {
    try { return canonicalRoot(candidate.root) === canonical; } catch { return resolve(candidate.root) === canonical; }
  });
  if (!project) throw new DesktopServiceError("not-registered", "Add the project to Code Butler before opening it.");
  return { ...project, root: canonical };
}

/**
 * Run one watcher-style ingestion pass now. It holds the project gate only for short database steps
 * and leaves sessions that are still being written for later, exactly like the background watcher.
 */
async function checkProjectSources(root: string): Promise<DesktopSourceCheck> {
  let result: SyncRunResult | undefined;
  let outcomes: OperationOutcome[];
  try {
    result = await syncWatchedProjectMemory(root, loadProjectConfig(root));
    outcomes = ingestionOutcomes(result);
  } catch (error) {
    outcomes = [errorOutcome(error, "ingestion")];
  }
  const status = recordManualWatchRun(root, outcomes);
  return {
    outcome: status.outcome ?? (status.ok ? "success" : "failed"),
    ...(status.error ? { reason: status.error } : {}),
    checkedAt: status.checkedAt,
    imported: { git: result?.sources.git.imported ?? 0, codex: result?.sources.codex.imported ?? 0, claude: result?.sources.claude.imported ?? 0 },
    promoted: result?.memories.promoted ?? 0,
    pending: result?.memories.pending ?? 0,
    waiting: result?.memories.waiting ?? 0
  };
}

/**
 * The daily AI review re-checks some flagged memories and automatic promotion makes corroborated
 * candidates durable; each runs only when enabled, and the review only with a review model set up.
 */
function overviewAutomation(root: string, config?: ProjectConfig): Pick<DesktopProjectOverview, "automation"> {
  try {
    const project = config ?? loadProjectConfig(root);
    let reviewModel = true;
    try { assertJobConfigured(project, "review"); } catch { reviewModel = false; }
    const promotion = project.promotion.automatic;
    return { automation: { aiReview: reviewModel && automaticReviewPolicy(project).enabled, promotion: promotion.enabled && promotion.coreCandidates } };
  } catch { return {}; }
}

async function projectOverview(project: WatchedProject & { lastRun?: DesktopProject["lastRun"]; lastCloudRun?: DesktopProject["lastCloudRun"] }): Promise<DesktopProjectOverview> {
  if(retrievalEnabled()) {
    scheduleRetrieval(project.root);
    return withPublishedIndex(project.root,()=>{
      const {summary:memory,status}=readPublishedSummary(project.root); const brief=readProjectBrief(project.root);
      const {counts:tiers,freshness}=readPublishedTiers(project.root);
      const working=readPublishedTierPage(project.root,{tier:"working",limit:3}).items as import("../retrieval/tiers.js").WorkingMemory[];
      return {project:desktopProject(project),narrative:{exists:brief.exists,summary:brief.summary,status:status ?? getProjectSummaryStatus(project.root)},memory,tiers,working,freshness,cloud:cloudStatusForProject(project),...overviewAutomation(project.root)};
    });
  }
  const requestStarted = performance.now();
  return projectOperation(project.root, () => {
    const workStarted = performance.now();
    const store = openConfiguredMemoryStore(project.root);
    store.init();
    try { return withReadCache(() => {
      const config = loadProjectConfig(project.root);
      const brief = readProjectBrief(project.root);
      const memory = store.getProjectSummary();
      const workingPage=readCanonicalTierPage(store,{tier:"working",limit:3});
      let status;
      try {
        status = getProjectSummaryStatus(project.root, { store, config, projectState: memory });
      } catch {
        // A missing Git executable or temporarily unavailable source must not block local browsing.
        status = getProjectSummaryStatus(project.root);
      }
      const result = {
        project: desktopProject(project),
        narrative: { exists: brief.exists, summary: brief.summary, status },
        memory,
        tiers:workingPage.counts,working:workingPage.items as import("../retrieval/tiers.js").WorkingMemory[],freshness:workingPage.freshness,
        cloud: cloudStatusForProject(project),
        ...overviewAutomation(project.root, config)
      };
      return result;
    }); } finally {
      try { store.close(); }
      finally { recordDesktopTiming("overview", workStarted - requestStarted, performance.now() - workStarted); }
    }
  });
}

async function refreshProjectNarrative(
  project: WatchedProject,
  force: boolean,
  options: ProjectSummaryOperationOptions = {}
) {
  try {
    return await projectOperation(project.root, async () => {
      const store = openConfiguredMemoryStore(project.root);
      store.init();
      try {
        const config = loadProjectConfig(project.root);
        importNewGitCommits(store, config);
        const status = getProjectSummaryStatus(project.root, { store, config });
        if (!status.stale) {
          return {
            checked: false,
            generated: false,
            summaryPath: status.summaryPath,
            ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
            skippedReason: "not_stale"
          };
        }
        return refreshProjectSummary(store, config, { ...options, force });
      } finally {
        store.close();
      }
    });
  } catch (error) {
    if (error instanceof DesktopServiceError) throw error;
    throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "Project summary refresh failed.");
  }
}

async function searchMemories(
  project: WatchedProject,
  query: string,
  qualityStatus: "active" | "needs_review" | "quarantined" | "all",
  offset: number,
  limit: number
) {
  if(retrievalEnabled()) {
    scheduleRetrieval(project.root);
    return withPublishedIndex(project.root,()=>readPublishedMemories(project.root,{query,qualityStatus,lifecycleStatus:"all",layer:"all",owner:"any",summaryOnly:true,offset,limit}).items.map(memory=>publishedDesktopMemory(project.root,memory)));
  }
  const requestStarted = performance.now();
  return projectOperation(project.root, () => {
    const workStarted = performance.now();
    const store = openConfiguredMemoryStore(project.root);
    store.init();
    try {
      const result = store.searchMemoryLayer({
        query,
        lifecycleStatus: "all",
        qualityStatus,
        layer: "all",
        owner: "any",
        summaryOnly: true,
        offset,
        limit
      }).map((memory) => desktopMemory(store, memory));
      return result;
    } finally {
      try { store.close(); }
      finally { recordDesktopTiming("search", workStarted - requestStarted, performance.now() - workStarted); }
    }
  });
}

async function memoryDetail(project: WatchedProject, id: string) {
  if(retrievalEnabled()) {
    scheduleRetrieval(project.root);
    return withPublishedIndex(project.root,()=>{
      const memory=readPublishedDetail(project.root,id);
      if(!memory) throw new DesktopServiceError("not-found","That memory is no longer available.");
      return publishedDesktopMemory(project.root,memory);
    });
  }
  return projectOperation(project.root, () => {
    const store = openConfiguredMemoryStore(project.root);
    store.init();
    try {
      const memory = store.readMemorySearchResultsByIds([id], {
        lifecycleStatus: "all",
        includeCandidates: true
      })[0];
      if (!memory) throw new DesktopServiceError("not-found", "That memory is no longer available in its current lifecycle.");
      return desktopMemory(store, memory);
    } finally {
      store.close();
    }
  });
}

async function resolveDesktopMemoryReview(
  project: WatchedProject,
  request: Extract<DesktopRequest, { action: "memory.review.resolve" }>
) {
  try {
    return await projectOperation(project.root, () => {
      const store = openConfiguredMemoryStore(project.root);
      store.init();
      try {
        return resolveMemoryReview(store, {
          memoryId: request.memoryId,
          category: request.category,
          action: request.reviewAction,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.reviewToken === undefined ? {} : { reviewToken: request.reviewToken }),
          ...(request.correction === undefined ? {} : { correction: request.correction })
        }, "desktop");
      } finally {
        store.close();
      }
    });
  } catch (error) {
    if (error instanceof StaleMemoryReviewError) {
      throw new DesktopServiceError("stale-review", error.message);
    }
    if (error instanceof DesktopServiceError) throw error;
    throw new DesktopServiceError("invalid-request", error instanceof Error ? error.message : "Memory review could not be saved.");
  }
}

function desktopMemory(store: ReturnType<typeof openConfiguredMemoryStore>, memory: MemorySearchResult): DesktopMemory {
  return desktopMemoryActions(memory,isPeerLayer(store,memory.layer));
}
function publishedDesktopMemory(root:string,memory:MemorySearchResult):DesktopMemory {
  const peer=withPublishedIndex(root,(_db,_p,prepare)=> (prepare("select peer from records where category=? and id=?").get(memory.kind,memory.id) as {peer:number}|undefined)?.peer===1);
  return desktopMemoryActions(memory,peer);
}
function desktopMemoryActions(memory:MemorySearchResult,peer:boolean):DesktopMemory {
  const presentation=presentMemory(memory,peer);
  const actions: DesktopMemory["reviewActions"] = [];
  const historical = memory.kind === "promoted" && memory.lifecycleStatus !== "current";
  if (!historical && !peer) {
    if (memory.qualityStatus === "needs_review" && !memory.qualityReasons.includes("missing_claim")) actions.push("verify");
    if (
      memory.qualityStatus === "quarantined" &&
      memory.qualityReasons.length > 0 &&
      memory.qualityReasons.every((reason) => reason === "legacy_low_signal_heuristic")
    ) actions.push("verify");
    // Confirming an active candidate is what lets automatic promotion make it durable.
    if (
      memory.kind === "candidate" &&
      memory.qualityStatus === "active" &&
      presentation.claim === "meaningful" &&
      !(memory.review?.action === "verify" && memory.review.current)
    ) actions.push("verify");
    actions.push("correct", "discard");
  }
  return { ...memory, presentation,canPolishWording:!historical && !peer && presentation.claim==="meaningful" && !["correct","discard"].includes(memory.review?.action??""), reviewActions: actions, canPromoteToProject: !historical && !peer && memory.layer !== "core" };
}

export function desktopSuccess(result: DesktopResult) {
  return { version: DESKTOP_PROTOCOL_VERSION, ok: true as const, result };
}

/** Reads share one read-cache scope, so per-file and per-source lookups run once per request. */
function canonicalDesktopRead<T extends DesktopResult>(root:string,read:(store:ReturnType<typeof openConfiguredMemoryStore>)=>T):Promise<T>{
  return canonicalDesktopStore(root,store=>withReadCache(()=>read(store)));
}

function canonicalDesktopStore<T extends DesktopResult>(root:string,work:(store:ReturnType<typeof openConfiguredMemoryStore>)=>T):Promise<T>{
  return projectOperation(root,()=>{const store=openConfiguredMemoryStore(root);store.init();try{return work(store);}finally{store.close();}});
}

async function desktopKnowledgeMutation<T extends DesktopResult>(root:string,write:(store:ReturnType<typeof openConfiguredMemoryStore>)=>T):Promise<T>{
  const intent=beginForegroundIntent(root);
  try {
    // Writes stay outside the read cache: it must never span a canonical mutation.
    const result=await canonicalDesktopStore(root,write);
    if(retrievalEnabled()) scheduleRetrieval(root);
    try { if(binding(root)?.enabled) requestAutomaticSync(root); }
    catch(error) { recordUnexpectedDesktopError(error,"topic-sync-request"); }
    return result;
  } finally { intent.release(); }
}

function desktopKnowledgeRead<T extends DesktopResult>(root:string,read:(data:KnowledgeSnapshot)=>T):T|Promise<T>{
  if(!retrievalEnabled())return canonicalDesktopRead(root,store=>read(readMemoryKnowledge(store)));
  scheduleRetrieval(root);return withPublishedIndex(root,(db,p)=>{
    if(p.format!==3)throw new DesktopServiceError("busy","Memory index is preparing; retry shortly");
    const row=db.prepare("select payload from memory_knowledge where id=1").get() as {payload:string}|undefined;
    if(!row)throw new DesktopServiceError("busy","Memory index is preparing; retry shortly");
    return read(JSON.parse(row.payload));
  });
}
