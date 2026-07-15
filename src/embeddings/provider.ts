import { isIP } from "node:net";

import { redactSensitiveText } from "../privacy/redaction.js";
import type {
  EmbeddingBatchResult,
  EmbeddingConfig,
  EmbeddingProvider,
  PrivacyConfig
} from "../types.js";
import {
  canonicalizeEmbeddingEndpoint,
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey
} from "./fingerprint.js";

type EmbeddingFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface EmbeddingProviderOptions {
  fetch?: EmbeddingFetch;
  env?: NodeJS.ProcessEnv;
}

export function createOpenAICompatibleEmbeddingProvider(
  config: EmbeddingConfig,
  privacy: PrivacyConfig,
  options: EmbeddingProviderOptions = {}
): EmbeddingProvider {
  const endpoint = canonicalizeEmbeddingEndpoint(config.baseUrl);
  const isRemote = !isLoopbackEmbeddingEndpoint(endpoint);
  if (isRemote && privacy.allowRemoteEmbeddings !== true) {
    throw new Error("Remote embeddings require privacy.allowRemoteEmbeddings=true");
  }
  const endpointHash = createEmbeddingEndpointHash(endpoint);
  const providerKey = createProviderKey(endpointHash, config.model);
  const fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const env = options.env ?? process.env;

  return {
    endpointHash,
    providerKey,
    isRemote,
    async embed(inputs): Promise<EmbeddingBatchResult> {
      if (inputs.length === 0) throw new Error("Embedding input batch must not be empty");
      const requestInputs = isRemote
        ? inputs.map((input) => redactSensitiveText(input).text)
        : [...inputs];
      const headers: Record<string, string> = { "content-type": "application/json" };
      const apiKey = config.apiKeyEnv ? env[config.apiKeyEnv]?.trim() : undefined;
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      let response: Response;
      try {
        response = await fetchImplementation(`${endpoint}/embeddings`, {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify({ model: config.model, input: requestInputs })
        });
      } catch {
        throw new Error("Embedding request failed");
      }
      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Embedding response was not valid JSON");
      }
      const vectors = validateEmbeddingResponse(payload, inputs.length);
      const dimension = vectors[0]?.length ?? 0;
      return {
        vectors,
        dimension,
        providerFingerprint: createProviderFingerprint(endpointHash, config.model, dimension)
      };
    }
  };
}

export function isLoopbackEmbeddingEndpoint(baseUrl: string): boolean {
  const hostname = new URL(canonicalizeEmbeddingEndpoint(baseUrl)).hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1") return true;
  if (hostname.startsWith("::ffff:")) {
    return isIpv4MappedIpv6Loopback(hostname);
  }
  return isIP(hostname) === 4 && isLoopbackIpv4(hostname);
}

function isLoopbackIpv4(address: string): boolean {
  return address.split(".")[0] === "127";
}

function isIpv4MappedIpv6Loopback(address: string): boolean {
  const mappedAddress = address.slice("::ffff:".length);
  if (isIP(mappedAddress) === 4) return isLoopbackIpv4(mappedAddress);
  const canonicalHex = mappedAddress.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!canonicalHex?.[1]) return false;
  return (Number.parseInt(canonicalHex[1], 16) >>> 8) === 127;
}

function validateEmbeddingResponse(payload: unknown, inputCount: number): number[][] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Embedding response format is invalid");
  }
  if (payload.data.length !== inputCount) {
    throw new Error("Embedding response count does not match input count");
  }
  let dimension: number | undefined;
  const vectors: number[][] = [];
  for (let index = 0; index < payload.data.length; index += 1) {
    const item = payload.data[index];
    if (!isRecord(item) || item.index !== index) {
      throw new Error("Embedding response order is invalid");
    }
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error("Embedding response format is invalid");
    }
    const vector = item.embedding;
    if (!vector.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Embedding response format is invalid");
    }
    dimension ??= vector.length;
    if (vector.length !== dimension) {
      throw new Error("Embedding response dimension is inconsistent");
    }
    vectors.push(vector);
  }
  return vectors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
