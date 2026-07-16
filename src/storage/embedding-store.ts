import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createEmbeddingContentHash,
  createProviderKey
} from "../embeddings/fingerprint.js";
import type { EmbeddingOwner, EmbeddingOwnerKind } from "../types.js";
import type { StorageContentPolicy } from "./content-policy.js";
import { withTransaction } from "./transactions.js";

export interface StoredEmbeddingProvider {
  providerKey: string;
  endpointHash: string;
  model: string;
}

export function listStoredEmbeddingProviders(db: DatabaseSync): StoredEmbeddingProvider[] {
  const rows = db.prepare(
    `select distinct provider_key, endpoint_hash, model
     from embedding_jobs
     union
     select distinct provider_key, endpoint_hash, model
     from embedding_vectors`
  ).all() as Array<{ provider_key: string; endpoint_hash: string; model: string }>;
  return rows.map((provider) => ({
    providerKey: provider.provider_key,
    endpointHash: provider.endpoint_hash,
    model: provider.model
  }));
}

export function listEmbeddingOwners(db: DatabaseSync): EmbeddingOwner[] {
  const chunks = db.prepare("select id, text from chunks order by id asc")
    .all() as Array<{ id: string; text: string }>;
  const memories = db.prepare(
    `select id, title, summary, reason, lifecycle_generation
     from memories
     where lifecycle_status = 'current'
     order by id asc`
  ).all() as Array<{
    id: string;
    title: string;
    summary: string;
    reason: string;
    lifecycle_generation: string;
  }>;
  return [
    ...chunks.map<EmbeddingOwner>((row) => ({
      ownerKind: "chunk",
      ownerId: row.id,
      text: row.text,
      contentHash: createEmbeddingContentHash(row.text),
      ownerVersion: ""
    })),
    ...memories.map<EmbeddingOwner>((row) => {
      const text = [row.title, row.summary, row.reason].join("\n\n");
      return {
        ownerKind: "memory",
        ownerId: row.id,
        text,
        contentHash: createEmbeddingContentHash(text),
        ownerVersion: row.lifecycle_generation
      };
    })
  ];
}

export function reconcileEmbeddingJobs(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  input: { providerKey: string; endpointHash: string; model: string }
): { enqueued: number; removedJobs: number; removedVectors: number } {
  validateProviderKey(input);
  const normalized = { ...input, model: contentPolicy.text(input.model) };
  return withTransaction(db, () => {
    const owners = listEmbeddingOwners(db);
    const eligible = new Map(
      owners.map((owner) => [
        embeddingOwnerIdentity(owner.ownerKind, owner.ownerId, owner.contentHash),
        owner.ownerVersion
      ])
    );
    let removedJobs = 0;
    const jobs = db.prepare(
      `select owner_kind, owner_id, content_hash, owner_version
       from embedding_jobs where provider_key = ?`
    ).all(normalized.providerKey) as Array<{
      owner_kind: EmbeddingOwnerKind;
      owner_id: string;
      content_hash: string;
      owner_version: string;
    }>;
    const deleteJob = db.prepare(
      `delete from embedding_jobs
       where owner_kind = ? and owner_id = ? and content_hash = ? and provider_key = ?`
    );
    for (const job of jobs) {
      const identity = embeddingOwnerIdentity(job.owner_kind, job.owner_id, job.content_hash);
      if (eligible.get(identity) === job.owner_version) continue;
      removedJobs += Number(deleteJob.run(
        job.owner_kind,
        job.owner_id,
        job.content_hash,
        normalized.providerKey
      ).changes);
    }

    let removedVectors = 0;
    const vectors = db.prepare(
      `select owner_kind, owner_id, content_hash, owner_version, provider_fingerprint
       from embedding_vectors where provider_key = ?`
    ).all(normalized.providerKey) as Array<{
      owner_kind: EmbeddingOwnerKind;
      owner_id: string;
      content_hash: string;
      owner_version: string;
      provider_fingerprint: string;
    }>;
    const deleteVector = db.prepare(
      `delete from embedding_vectors
       where owner_kind = ? and owner_id = ? and content_hash = ? and provider_fingerprint = ?`
    );
    for (const vector of vectors) {
      const identity = embeddingOwnerIdentity(vector.owner_kind, vector.owner_id, vector.content_hash);
      if (eligible.get(identity) === vector.owner_version) continue;
      removedVectors += Number(deleteVector.run(
        vector.owner_kind,
        vector.owner_id,
        vector.content_hash,
        vector.provider_fingerprint
      ).changes);
    }

    const now = new Date().toISOString();
    const insert = db.prepare(
      `insert into embedding_jobs
         (owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
          state, attempts, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       on conflict(owner_kind, owner_id, content_hash, provider_key) do nothing`
    );
    let enqueued = 0;
    for (const owner of owners) {
      enqueued += Number(insert.run(
        owner.ownerKind,
        owner.ownerId,
        owner.contentHash,
        owner.ownerVersion,
        normalized.providerKey,
        normalized.endpointHash,
        normalized.model,
        now,
        now
      ).changes);
    }
    return { enqueued, removedJobs, removedVectors };
  });
}

export function beginEmbeddingIndexRebuild(
  db: DatabaseSync,
  contentPolicy: StorageContentPolicy,
  input: { providerKey: string; endpointHash: string; model: string }
): { removedVectors: number; requeued: number; rebuildToken: string } {
  validateProviderKey(input);
  const normalized = { ...input, model: contentPolicy.text(input.model) };
  return withTransaction(db, () => {
    const rebuildToken = randomUUID();
    const removedVectors = Number(
      db.prepare("delete from embedding_vectors where provider_key = ?")
        .run(normalized.providerKey).changes
    );
    const now = new Date().toISOString();
    const requeue = db.prepare(
      `insert into embedding_jobs
         (owner_kind, owner_id, content_hash, owner_version, provider_key, endpoint_hash, model,
          index_generation, target_fingerprint, state, attempts, provider_fingerprint,
          last_error, created_at, updated_at, completed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null, 'pending', 0, null, null, ?, ?, null)
       on conflict(owner_kind, owner_id, content_hash, provider_key) do update set
         owner_version = excluded.owner_version,
         endpoint_hash = excluded.endpoint_hash,
         model = excluded.model,
         index_generation = excluded.index_generation,
         target_fingerprint = null,
         state = 'pending',
         provider_fingerprint = null,
         last_error = null,
         updated_at = excluded.updated_at,
         completed_at = null`
    );
    let requeued = 0;
    for (const owner of listEmbeddingOwners(db)) {
      requeued += Number(requeue.run(
        owner.ownerKind,
        owner.ownerId,
        owner.contentHash,
        owner.ownerVersion,
        normalized.providerKey,
        normalized.endpointHash,
        normalized.model,
        rebuildToken,
        now,
        now
      ).changes);
    }
    return { removedVectors, requeued, rebuildToken };
  });
}

export function activateEmbeddingIndexRebuild(
  db: DatabaseSync,
  input: {
    providerKey: string;
    rebuildToken: string;
    providerFingerprint: string;
  }
): number {
  if (!input.rebuildToken.trim()) throw new Error("Embedding rebuild token is required");
  if (!/^[a-f0-9]{64}$/.test(input.providerFingerprint)) {
    throw new Error("Embedding rebuild target fingerprint is invalid");
  }
  return withTransaction(db, () => {
    const rows = db.prepare(
      `select distinct target_fingerprint
       from embedding_jobs
       where provider_key = ? and index_generation = ?`
    ).all(input.providerKey, input.rebuildToken) as Array<{ target_fingerprint: string | null }>;
    if (rows.length === 0) throw new Error("Embedding rebuild generation is no longer active");
    if (rows.some((row) =>
      row.target_fingerprint !== null && row.target_fingerprint !== input.providerFingerprint
    )) {
      throw new Error("Embedding rebuild generation already has a different target fingerprint");
    }
    return Number(db.prepare(
      `update embedding_jobs set target_fingerprint = ?, updated_at = ?
       where provider_key = ? and index_generation = ?`
    ).run(
      input.providerFingerprint,
      new Date().toISOString(),
      input.providerKey,
      input.rebuildToken
    ).changes);
  });
}

function embeddingOwnerIdentity(
  ownerKind: EmbeddingOwnerKind,
  ownerId: string,
  contentHash: string
): string {
  return `${ownerKind}\0${ownerId}\0${contentHash}`;
}

function validateProviderKey(input: { providerKey: string; endpointHash: string; model: string }): void {
  if (input.providerKey !== createProviderKey(input.endpointHash, input.model)) {
    throw new Error("providerKey does not match endpointHash and model");
  }
}
