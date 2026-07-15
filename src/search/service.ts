import { createProviderFingerprint, createProviderKey, createEmbeddingEndpointHash } from "../embeddings/fingerprint.js";
import { createOpenAICompatibleEmbeddingProvider, isLoopbackEmbeddingEndpoint } from "../embeddings/provider.js";
import { redactSensitiveText } from "../privacy/redaction.js";
import type { MemoryStore, MemoryLifecycleStatusFilter, MemoryQualityStatusFilter } from "../storage/store.js";
import type {
  EmbeddingProvider,
  MemorySearchResult,
  MemoryType,
  ProjectConfig,
  SearchResult,
  SourceType
} from "../types.js";
import { decodeFloat32Vector, rankByCosine, reciprocalRankFuse, type RankingMetadata } from "./hybrid.js";

export interface SearchServiceOptions {
  provider?: EmbeddingProvider | undefined;
  providerFactory?: ((config: ProjectConfig["embeddings"], privacy: ProjectConfig["privacy"]) => EmbeddingProvider) | undefined;
}

export interface MemorySearchInput {
  query?: string;
  type?: MemoryType;
  status?: "promoted" | "candidate";
  qualityStatus?: MemoryQualityStatusFilter;
  lifecycleStatus?: MemoryLifecycleStatusFilter;
  limit?: number;
}

export async function searchProjectMemory(
  store: MemoryStore,
  config: ProjectConfig,
  input: { query: string; sourceTypes?: SourceType[]; limit?: number },
  options: SearchServiceOptions = {}
): Promise<{ memories: MemorySearchResult[]; results: SearchResult[] }> {
  const memoryInput: MemorySearchInput = {
    query: input.query,
    ...(input.limit === undefined ? {} : { limit: input.limit })
  };
  const lexical = {
    memories: store.searchMemoryLayer(memoryInput),
    results: store.search(input)
  };
  const semantic = await prepareSemanticSearch(store, config, input.query, options);
  if (!semantic) return lexical;
  try {
    const results = fuseRawResults(store, lexical.results, semantic, input.sourceTypes, input.limit, config.retrieval.rrfK);
    const memories = fuseMemoryResults(store, lexical.memories, semantic, memoryInput, config.retrieval.rrfK);
    if (results === undefined && memories === undefined) return lexical;
    return { results: results ?? lexical.results, memories: memories ?? lexical.memories };
  } catch {
    return lexical;
  }
}

export async function findProjectMemories(
  store: MemoryStore,
  config: ProjectConfig,
  input: MemorySearchInput,
  options: SearchServiceOptions = {}
): Promise<MemorySearchResult[]> {
  const lexical = store.searchMemoryLayer(input);
  if (
    !input.query
    || input.status === "candidate"
    || (input.lifecycleStatus !== undefined && input.lifecycleStatus !== "current")
  ) return lexical;
  const semantic = await prepareSemanticSearch(store, config, input.query, options);
  if (!semantic) return lexical;
  try {
    return fuseMemoryResults(store, lexical, semantic, input, config.retrieval.rrfK) ?? lexical;
  } catch {
    return lexical;
  }
}

interface SemanticContext {
  query: number[];
  vectors: ReturnType<MemoryStore["listActiveEmbeddingVectors"]>;
}

async function prepareSemanticSearch(
  store: MemoryStore,
  config: ProjectConfig,
  query: string,
  options: SearchServiceOptions
): Promise<SemanticContext | undefined> {
  if (config.retrieval.mode !== "hybrid" || !config.embeddings.enabled) return undefined;
  try {
    const expectedEndpointHash = createEmbeddingEndpointHash(config.embeddings.baseUrl);
    const expectedProviderKey = createProviderKey(expectedEndpointHash, config.embeddings.model);
    const provider = options.provider
      ?? (options.providerFactory ?? createOpenAICompatibleEmbeddingProvider)(config.embeddings, config.privacy);
    if (provider.endpointHash !== expectedEndpointHash || provider.providerKey !== expectedProviderKey) return undefined;
    const isRemote = !isLoopbackEmbeddingEndpoint(config.embeddings.baseUrl);
    if (provider.isRemote !== isRemote) return undefined;
    if (isRemote && config.privacy.allowRemoteEmbeddings !== true) return undefined;
    const embeddingQuery = isRemote ? redactSensitiveText(query).text : query;
    const embedded = await provider.embed([embeddingQuery]);
    if (
      embedded.vectors.length !== 1
      || !Number.isInteger(embedded.dimension)
      || embedded.dimension <= 0
      || embedded.vectors[0]?.length !== embedded.dimension
      || embedded.vectors[0].some((value) => !Number.isFinite(value))
    ) return undefined;
    const fingerprint = createProviderFingerprint(provider.endpointHash, config.embeddings.model, embedded.dimension);
    if (embedded.providerFingerprint !== fingerprint) return undefined;
    const vectors = store.listActiveEmbeddingVectors({
      providerKey: provider.providerKey,
      providerFingerprint: fingerprint
    });
    if (vectors.length === 0 || vectors.some((vector) => vector.dimension !== embedded.dimension)) return undefined;
    return { query: embedded.vectors[0], vectors };
  } catch {
    return undefined;
  }
}

function fuseRawResults(
  store: MemoryStore,
  lexical: SearchResult[],
  semantic: SemanticContext,
  sourceTypes: SourceType[] | undefined,
  requestedLimit: number | undefined,
  k: number
): SearchResult[] | undefined {
  const vectors = semantic.vectors.filter((vector) => vector.ownerKind === "chunk");
  if (vectors.length === 0) return undefined;
  const ranked = rankByCosine(semantic.query, vectors.map((vector) => ({
    id: vector.ownerId,
    vector: decodeFloat32Vector(vector.vectorBlob, vector.dimension)
  })));
  const resolvedSemanticResults = store.readSearchResultsByChunkIds(ranked.map((item) => item.id));
  if (resolvedSemanticResults.length !== vectors.length) throw new Error("Embedding coverage is incomplete");
  const semanticResults = resolvedSemanticResults
    .filter((result) => !sourceTypes?.length || sourceTypes.includes(result.sourceType));
  const fused = reciprocalRankFuse(
    lexical.map((result) => ({ id: result.chunkId })),
    semanticResults.map((result) => ({ id: result.chunkId })),
    { k, limit: normalizeLimit(requestedLimit) }
  );
  const byId = new Map([...semanticResults, ...lexical].map((result) => [result.chunkId, result]));
  return fused.flatMap((ranking) => {
    const result = byId.get(ranking.id);
    return result ? [{ ...result, ranking: toRankingMetadata(ranking) }] : [];
  });
}

function fuseMemoryResults(
  store: MemoryStore,
  lexical: MemorySearchResult[],
  semantic: SemanticContext,
  input: MemorySearchInput,
  k: number
): MemorySearchResult[] | undefined {
  if (input.status === "candidate" || (input.lifecycleStatus !== undefined && input.lifecycleStatus !== "current")) return undefined;
  const vectors = semantic.vectors.filter((vector) => vector.ownerKind === "memory");
  if (vectors.length === 0) return undefined;
  const ranked = rankByCosine(semantic.query, vectors.map((vector) => ({
    id: vector.ownerId,
    vector: decodeFloat32Vector(vector.vectorBlob, vector.dimension)
  })));
  const resolvedSemanticResults = store.readMemorySearchResultsByIds(ranked.map((item) => item.id));
  if (resolvedSemanticResults.length !== vectors.length) throw new Error("Embedding coverage is incomplete");
  const semanticResults = resolvedSemanticResults
    .filter((memory) => input.type === undefined || memory.type === input.type)
    .filter((memory) => input.qualityStatus === "all" || memory.qualityStatus === (input.qualityStatus ?? "active"));
  const lexicalPromoted = lexical.filter((memory) => memory.kind === "promoted");
  const candidates = lexical.filter((memory) => memory.kind === "candidate");
  const limit = normalizeLimit(input.limit);
  const fused = reciprocalRankFuse(
    lexicalPromoted.map((memory) => ({ id: memory.id })),
    semanticResults.map((memory) => ({ id: memory.id })),
    { k, limit }
  );
  const byId = new Map([...semanticResults, ...lexicalPromoted].map((memory) => [memory.id, memory]));
  const promoted = fused.flatMap((ranking) => {
    const memory = byId.get(ranking.id);
    return memory ? [{ ...memory, ranking: toRankingMetadata(ranking) }] : [];
  });
  return [...promoted, ...candidates].slice(0, limit);
}

function toRankingMetadata(value: RankingMetadata): RankingMetadata {
  return {
    ...(value.lexicalRank === undefined ? {} : { lexicalRank: value.lexicalRank }),
    ...(value.semanticRank === undefined ? {} : { semanticRank: value.semanticRank }),
    fusedScore: value.fusedScore
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.floor(limit), 100));
}
