import { createHash } from "node:crypto";

export function createEmbeddingContentHash(content: string): string {
  return sha256(content);
}

export function canonicalizeEmbeddingEndpoint(baseUrl: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("Embedding endpoint must be a valid URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Embedding endpoint must use http or https");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Embedding endpoint credentials are not allowed in the URL");
  }
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  const canonical = endpoint.toString();
  return endpoint.pathname === "/" ? canonical.replace(/\/$/, "") : canonical;
}

export function createEmbeddingEndpointHash(baseUrl: string): string {
  return sha256(canonicalizeEmbeddingEndpoint(baseUrl));
}

export function createProviderKey(endpointHash: string, model: string): string {
  return sha256(`${endpointHash}\0${model}`);
}

export function createProviderFingerprint(endpointHash: string, model: string, dimension: number): string {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("Embedding dimension must be a positive integer");
  }
  return sha256(`${endpointHash}\0${model}\0${dimension}`);
}

export function encodeFloat32Vector(vector: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error("Embedding vector values must be finite numbers");
    }
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  }
  return bytes;
}

export function decodeFloat32Vector(blob: Uint8Array, dimension?: number): Float32Array {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Float32 vector byte length must be a multiple of 4");
  }
  const actualDimension = blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (dimension !== undefined && actualDimension !== dimension) {
    throw new Error(`Float32 vector byte length ${blob.byteLength} does not match dimension ${dimension}`);
  }
  const values = new Float32Array(actualDimension);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let index = 0; index < actualDimension; index += 1) {
    values[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
