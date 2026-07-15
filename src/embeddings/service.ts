import { redactSensitiveText } from "../privacy/redaction.js";
import type { MemoryStore } from "../storage/store.js";
import type {
  EmbeddingConfig,
  EmbeddingJob,
  EmbeddingProvider,
  PrivacyConfig
} from "../types.js";
import {
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey,
  encodeFloat32Vector
} from "./fingerprint.js";
import {
  createOpenAICompatibleEmbeddingProvider,
  isLoopbackEmbeddingEndpoint
} from "./provider.js";

export interface EmbeddingServiceConfig {
  embeddings: EmbeddingConfig;
  privacy: PrivacyConfig;
}

export interface EmbeddingStatus {
  enabled: boolean;
  eligible: number;
  activeCoverage: number;
  pending: number;
  complete: number;
  failed: number;
  attempts: number;
  warnings: string[];
  providerKey?: string | undefined;
  model?: string | undefined;
  dimension?: number | undefined;
  providerFingerprint?: string | undefined;
}

export interface EmbeddingBuildResult extends EmbeddingStatus {
  usable: boolean;
  built: number;
  retried: number;
  enqueued: number;
  removedJobs: number;
  removedVectors: number;
}

export interface EmbeddingServiceOptions {
  provider?: EmbeddingProvider | undefined;
  providerFactory?: ((config: EmbeddingConfig, privacy: PrivacyConfig) => EmbeddingProvider) | undefined;
}

export async function buildEmbeddings(
  store: MemoryStore,
  config: EmbeddingServiceConfig,
  options: EmbeddingServiceOptions = {}
): Promise<EmbeddingBuildResult> {
  const eligible = store.listEmbeddingOwners().length;
  if (!config.embeddings.enabled) {
    return emptyBuildStatus(false, eligible, ["Embeddings are disabled"]);
  }

  const resolved = resolveProvider(config, options);
  if (!resolved.provider) {
    if (resolved.providerKey === undefined) return emptyBuildStatus(true, eligible, resolved.warnings);
    return {
      ...statusForProvider(store, eligible, resolved.providerKey, config.embeddings.model, resolved.warnings),
      usable: false,
      built: 0,
      retried: 0,
      enqueued: 0,
      removedJobs: 0,
      removedVectors: 0
    };
  }
  const provider = resolved.provider;
  if (provider.isRemote && config.privacy.allowRemoteEmbeddings !== true) {
    const warnings = [...resolved.warnings, "Remote embeddings require privacy.allowRemoteEmbeddings=true"];
    return {
      ...statusForProvider(store, eligible, provider.providerKey, config.embeddings.model, warnings),
      usable: false,
      built: 0,
      retried: 0,
      enqueued: 0,
      removedJobs: 0,
      removedVectors: 0
    };
  }
  const reconciliation = store.reconcileEmbeddingJobs({
    providerKey: provider.providerKey,
    endpointHash: provider.endpointHash,
    model: config.embeddings.model
  });
  const warnings = [...resolved.warnings];
  const existingVectors = store.listActiveEmbeddingVectors({ providerKey: provider.providerKey });
  const existingDimensions = new Set(existingVectors.map((vector) => vector.dimension));
  const existingFingerprints = new Set(existingVectors.map((vector) => vector.providerFingerprint));
  let built = 0;
  let retried = 0;
  let buildDimension = existingDimensions.size === 1 ? existingVectors[0]?.dimension : undefined;
  let removedVectors = reconciliation.removedVectors;
  let indexWasRebuilt = false;
  const completedThisBuild = new Set<string>();

  if (existingDimensions.size > 1 || existingFingerprints.size > 1) {
    warnings.push("Active embedding vectors contain mixed dimensions or provider fingerprints");
    const rebuilt = store.beginEmbeddingIndexRebuild({
      providerKey: provider.providerKey,
      endpointHash: provider.endpointHash,
      model: config.embeddings.model
    });
    removedVectors += rebuilt.removedVectors;
    buildDimension = undefined;
    indexWasRebuilt = true;
  }

  if (existingVectors.length === 0) {
    const providerJobs = store.listEmbeddingJobs({ providerKey: provider.providerKey });
    if (providerJobs.length > 0) {
      const persistedGenerations = unique(
        providerJobs.flatMap((job) => job.indexGeneration ? [job.indexGeneration] : [])
      );
      if (persistedGenerations.length !== 1) {
        const rebuilt = store.beginEmbeddingIndexRebuild({
          providerKey: provider.providerKey,
          endpointHash: provider.endpointHash,
          model: config.embeddings.model
        });
        removedVectors += rebuilt.removedVectors;
        indexWasRebuilt = true;
      }
    }
  }

  const attempted = new Set<string>();
  const allowedIndexGenerations = new Set(
    store.listEmbeddingJobs({ providerKey: provider.providerKey }).map((job) => job.indexGeneration)
  );
  while (true) {
    const jobs = store.listEmbeddingJobs({ providerKey: provider.providerKey })
      .filter((job) => job.state === "pending" || job.state === "failed")
      .filter((job) => allowedIndexGenerations.has(job.indexGeneration))
      .filter((job) => !attempted.has(jobAttemptIdentity(job)));
    if (jobs.length === 0) break;
    let batch = jobs.slice(0, config.embeddings.batchSize);
    for (const job of batch) attempted.add(jobAttemptIdentity(job));
    const owners = new Map(
      store.listEmbeddingOwners().map((owner) => [ownerIdentity(owner.ownerKind, owner.ownerId, owner.contentHash), owner])
    );
    const batchOwners = batch.map((job) => owners.get(ownerIdentity(job.ownerKind, job.ownerId, job.contentHash)));
    if (batchOwners.some((owner) => !owner)) {
      failBatch(store, batch, "Embedding owner is no longer eligible", warnings);
      continue;
    }
    const inputs = batchOwners.map((owner) => owner!.text);
    const retryingOwners = new Set(
      batch.filter((job) => job.attempts > 0)
        .map((job) => ownerIdentity(job.ownerKind, job.ownerId, job.contentHash))
    );
    const providerInputs = provider.isRemote
      ? inputs.map((input) => redactSensitiveText(input).text)
      : inputs;
    try {
      store.recordEmbeddingJobAttempts(batch);
    } catch (error) {
      warnings.push(sanitizeError(error));
      continue;
    }
    try {
      const embedded = await provider.embed(providerInputs);
      validateBatchResult(embedded, batch.length, provider, config.embeddings.model);
      const batchTargets = unique(batch.flatMap((job) => job.targetFingerprint ? [job.targetFingerprint] : []));
      const pendingRebuildTokens = unique(batch.flatMap((job) =>
        job.indexGeneration && !job.targetFingerprint ? [job.indexGeneration] : []));
      if (batchTargets.length > 1 || pendingRebuildTokens.length > 1) {
        throw new Error("Embedding batch spans multiple rebuild generations");
      }
      if (batchTargets[0] !== undefined && batchTargets[0] !== embedded.providerFingerprint) {
        if (indexWasRebuilt) throw new Error("Embedding dimension changed during build");
        const rebuilt = store.beginEmbeddingIndexRebuild({
          providerKey: provider.providerKey,
          endpointHash: provider.endpointHash,
          model: config.embeddings.model
        });
        removedVectors += rebuilt.removedVectors;
        store.activateEmbeddingIndexRebuild({
          providerKey: provider.providerKey,
          rebuildToken: rebuilt.rebuildToken,
          providerFingerprint: embedded.providerFingerprint
        });
        indexWasRebuilt = true;
        buildDimension = embedded.dimension;
        attempted.clear();
        allowedIndexGenerations.clear();
        allowedIndexGenerations.add(rebuilt.rebuildToken);
        completedThisBuild.clear();
        built = 0;
        retried = 0;
        batch = refreshEmbeddingJobs(store, batch);
        for (const job of batch) attempted.add(jobAttemptIdentity(job));
      }
      if (batchTargets[0] !== undefined) {
        indexWasRebuilt = true;
        buildDimension = embedded.dimension;
      }
      if (pendingRebuildTokens[0] !== undefined) {
        try {
          store.activateEmbeddingIndexRebuild({
            providerKey: provider.providerKey,
            rebuildToken: pendingRebuildTokens[0],
            providerFingerprint: embedded.providerFingerprint
          });
        } catch (error) {
          allowedIndexGenerations.delete(pendingRebuildTokens[0]);
          throw error;
        }
        indexWasRebuilt = true;
        buildDimension = embedded.dimension;
        batch = refreshEmbeddingJobs(store, batch);
      } else if (buildDimension !== undefined && embedded.dimension !== buildDimension) {
        if (indexWasRebuilt) throw new Error("Embedding dimension changed during build");
        const rebuilt = store.beginEmbeddingIndexRebuild({
          providerKey: provider.providerKey,
          endpointHash: provider.endpointHash,
          model: config.embeddings.model
        });
        removedVectors += rebuilt.removedVectors;
        store.activateEmbeddingIndexRebuild({
          providerKey: provider.providerKey,
          rebuildToken: rebuilt.rebuildToken,
          providerFingerprint: embedded.providerFingerprint
        });
        indexWasRebuilt = true;
        buildDimension = embedded.dimension;
        attempted.clear();
        allowedIndexGenerations.clear();
        allowedIndexGenerations.add(rebuilt.rebuildToken);
        completedThisBuild.clear();
        built = 0;
        retried = 0;
        batch = refreshEmbeddingJobs(store, batch);
        for (const job of batch) attempted.add(jobAttemptIdentity(job));
      }
      buildDimension ??= embedded.dimension;
      for (let index = 0; index < batch.length; index += 1) {
        const job = batch[index]!;
        try {
          store.completeEmbeddingJob({
            ownerKind: job.ownerKind,
            ownerId: job.ownerId,
            contentHash: job.contentHash,
            ownerVersion: job.ownerVersion,
            indexGeneration: job.indexGeneration,
            providerKey: provider.providerKey,
            endpointHash: provider.endpointHash,
            model: config.embeddings.model,
            providerFingerprint: embedded.providerFingerprint,
            dimension: embedded.dimension,
            vectorBlob: encodeFloat32Vector(embedded.vectors[index]!)
          });
          built += 1;
          completedThisBuild.add(completedEmbeddingIdentity(job, embedded.providerFingerprint));
          if (retryingOwners.has(ownerIdentity(job.ownerKind, job.ownerId, job.contentHash))) retried += 1;
        } catch (error) {
          failJob(store, job, error, warnings);
        }
      }
    } catch (error) {
      failBatch(store, batch, error, warnings, inputs);
    }
  }

  const status = statusForProvider(store, eligible, provider.providerKey, config.embeddings.model, warnings);
  const activeVectors = store.listActiveEmbeddingVectors({ providerKey: provider.providerKey });
  built = activeVectors.filter((vector) => completedThisBuild.has(completedEmbeddingIdentity(vector, vector.providerFingerprint))).length;
  const activeDimensions = new Set(activeVectors.map((vector) => vector.dimension));
  const activeFingerprints = new Set(activeVectors.map((vector) => vector.providerFingerprint));
  return {
    ...status,
    usable: activeDimensions.size <= 1 && activeFingerprints.size <= 1,
    built,
    retried,
    enqueued: reconciliation.enqueued,
    removedJobs: reconciliation.removedJobs,
    removedVectors
  };
}

export function getEmbeddingStatus(
  store: MemoryStore,
  config: EmbeddingServiceConfig,
  options: EmbeddingServiceOptions = {}
): EmbeddingStatus {
  const eligible = store.listEmbeddingOwners().length;
  if (!config.embeddings.enabled) {
    return emptyStatus(false, eligible, ["Embeddings are disabled"]);
  }
  const resolved = resolveProvider(config, options);
  if (!resolved.provider) {
    if (resolved.providerKey === undefined) return emptyStatus(true, eligible, resolved.warnings);
    return statusForProvider(store, eligible, resolved.providerKey, config.embeddings.model, resolved.warnings);
  }
  return statusForProvider(
    store,
    eligible,
    resolved.provider.providerKey,
    config.embeddings.model,
    resolved.warnings
  );
}

function resolveProvider(
  config: EmbeddingServiceConfig,
  options: EmbeddingServiceOptions
): { provider?: EmbeddingProvider | undefined; providerKey?: string | undefined; warnings: string[] } {
  let expectedEndpointHash: string;
  let expectedProviderKey: string;
  try {
    expectedEndpointHash = createEmbeddingEndpointHash(config.embeddings.baseUrl);
    expectedProviderKey = createProviderKey(expectedEndpointHash, config.embeddings.model);
  } catch (error) {
    return { warnings: [sanitizeError(error)] };
  }
  try {
    const provider = options.provider
      ?? (options.providerFactory ?? createOpenAICompatibleEmbeddingProvider)(config.embeddings, config.privacy);
    if (provider.endpointHash !== expectedEndpointHash || provider.providerKey !== expectedProviderKey) {
      throw new Error("Embedding provider metadata does not match configured endpoint and model");
    }
    const expectedRemote = !isLoopbackEmbeddingEndpoint(config.embeddings.baseUrl);
    if (provider.isRemote !== expectedRemote) {
      throw new Error("Embedding provider locality does not match configured endpoint");
    }
    return { provider, providerKey: expectedProviderKey, warnings: [] };
  } catch (error) {
    return { providerKey: expectedProviderKey, warnings: [sanitizeError(error)] };
  }
}

function validateBatchResult(
  result: Awaited<ReturnType<EmbeddingProvider["embed"]>>,
  expectedCount: number,
  provider: EmbeddingProvider,
  model: string
): void {
  if (!Number.isInteger(result.dimension) || result.dimension <= 0) {
    throw new Error("Embedding batch dimension is invalid");
  }
  if (result.vectors.length !== expectedCount) {
    throw new Error("Embedding batch vector count is invalid");
  }
  if (result.vectors.some((vector) =>
    vector.length !== result.dimension || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("Embedding batch dimensions are inconsistent");
  }
  const expectedFingerprint = createProviderFingerprint(provider.endpointHash, model, result.dimension);
  if (result.providerFingerprint !== expectedFingerprint) {
    throw new Error("Embedding batch provider fingerprint is invalid");
  }
}

function failBatch(
  store: MemoryStore,
  jobs: EmbeddingJob[],
  error: unknown,
  warnings: string[],
  ownerInputs: string[] = []
): void {
  const message = sanitizeError(error, ownerInputs);
  warnings.push(message);
  for (const job of jobs) failJob(store, job, message, warnings, false);
}

function failJob(
  store: MemoryStore,
  job: EmbeddingJob,
  error: unknown,
  warnings: string[],
  addWarning = true
): void {
  const message = sanitizeError(error);
  if (addWarning) warnings.push(message);
  try {
    store.markEmbeddingJobFailed({
      ownerKind: job.ownerKind,
      ownerId: job.ownerId,
      contentHash: job.contentHash,
      ownerVersion: job.ownerVersion,
      providerKey: job.providerKey,
      indexGeneration: job.indexGeneration,
      targetFingerprint: job.targetFingerprint,
      error: message
    });
  } catch (storageError) {
    warnings.push(sanitizeError(storageError));
  }
}

function statusForProvider(
  store: MemoryStore,
  eligible: number,
  providerKey: string,
  model: string,
  warnings: string[]
): EmbeddingStatus {
  const jobs = store.listEmbeddingJobs({ providerKey });
  const vectors = store.listActiveEmbeddingVectors({ providerKey });
  const dimensions = new Set(vectors.map((vector) => vector.dimension));
  const fingerprints = new Set(vectors.map((vector) => vector.providerFingerprint));
  const activeCoverage = new Set(vectors.map((vector) => `${vector.ownerKind}\0${vector.ownerId}`)).size;
  return {
    enabled: true,
    eligible,
    activeCoverage,
    pending: jobs.filter((job) => job.state === "pending").length,
    complete: jobs.filter((job) => job.state === "complete").length,
    failed: jobs.filter((job) => job.state === "failed").length,
    attempts: jobs.reduce((sum, job) => sum + job.attempts, 0),
    warnings: unique(warnings),
    providerKey,
    model,
    ...(dimensions.size === 1 ? { dimension: vectors[0]!.dimension } : {}),
    ...(fingerprints.size === 1 ? { providerFingerprint: vectors[0]!.providerFingerprint } : {})
  };
}

function emptyStatus(enabled: boolean, eligible: number, warnings: string[]): EmbeddingStatus {
  return { enabled, eligible, activeCoverage: 0, pending: 0, complete: 0, failed: 0, attempts: 0, warnings: unique(warnings) };
}

function emptyBuildStatus(enabled: boolean, eligible: number, warnings: string[]): EmbeddingBuildResult {
  return {
    ...emptyStatus(enabled, eligible, warnings),
    usable: false,
    built: 0,
    retried: 0,
    enqueued: 0,
    removedJobs: 0,
    removedVectors: 0
  };
}

function sanitizeError(error: unknown, ownerInputs: string[] = []): string {
  let raw = error instanceof Error ? error.message : String(error);
  const inputs = [...new Set(ownerInputs.filter((input) => input.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const input of inputs) {
    raw = raw.split(input).join("[REDACTED:EMBEDDING_INPUT]");
  }
  const sanitized = redactSensitiveText(raw.replace(/[\r\n]+/g, " ")).text.trim();
  return (sanitized || "Embedding request failed").slice(0, 1_000);
}

function ownerIdentity(ownerKind: string, ownerId: string, contentHash: string): string {
  return `${ownerKind}\0${ownerId}\0${contentHash}`;
}

function jobAttemptIdentity(job: EmbeddingJob): string {
  return `${ownerIdentity(job.ownerKind, job.ownerId, job.contentHash)}\0${job.ownerVersion}\0${job.providerKey}\0${job.indexGeneration}\0${job.targetFingerprint ?? ""}`;
}

function refreshEmbeddingJobs(store: MemoryStore, jobs: EmbeddingJob[]): EmbeddingJob[] {
  const current = new Map(
    store.listEmbeddingJobs({ providerKey: jobs[0]!.providerKey }).map((job) => [
      ownerIdentity(job.ownerKind, job.ownerId, job.contentHash),
      job
    ])
  );
  return jobs.map((job) => {
    const refreshed = current.get(ownerIdentity(job.ownerKind, job.ownerId, job.contentHash));
    if (!refreshed) throw new Error("Embedding job is no longer available after index rebuild");
    return refreshed;
  });
}

function completedEmbeddingIdentity(
  value: Pick<EmbeddingJob, "ownerKind" | "ownerId" | "contentHash">,
  providerFingerprint: string
): string {
  return `${ownerIdentity(value.ownerKind, value.ownerId, value.contentHash)}\0${providerFingerprint}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
