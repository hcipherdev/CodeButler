import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeEmbeddingEndpoint,
  createEmbeddingContentHash,
  createEmbeddingEndpointHash,
  createProviderFingerprint,
  createProviderKey,
  decodeFloat32Vector,
  encodeFloat32Vector
} from "../src/embeddings/fingerprint.js";
import { createOpenAICompatibleEmbeddingProvider } from "../src/embeddings/provider.js";

describe("embedding fingerprints", () => {
  it("canonicalizes endpoints and creates dimension-isolated fingerprints", () => {
    const canonical = canonicalizeEmbeddingEndpoint("HTTP://LOCALHOST:80/v1///?ignored=yes#fragment");
    expect(canonical).toBe("http://localhost/v1");
    const endpointHash = createEmbeddingEndpointHash(canonical);
    expect(endpointHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createEmbeddingEndpointHash("http://localhost/v1/")).toBe(endpointHash);
    expect(createEmbeddingContentHash("same content")).toMatch(/^[a-f0-9]{64}$/);
    const providerKey = createProviderKey(endpointHash, "model-a");
    expect(providerKey).toMatch(/^[a-f0-9]{64}$/);
    expect(createProviderFingerprint(endpointHash, "model-a", 3)).not.toBe(
      createProviderFingerprint(endpointHash, "model-a", 4)
    );
  });

  it("round-trips validated Float32 blobs", () => {
    const blob = encodeFloat32Vector([1.5, -2.25, 0]);
    expect(blob.byteLength).toBe(12);
    expect(Array.from(decodeFloat32Vector(blob, 3))).toEqual([1.5, -2.25, 0]);
    expect(() => decodeFloat32Vector(blob, 2)).toThrow("Float32 vector byte length");
    expect(() => decodeFloat32Vector(new Uint8Array(3))).toThrow("multiple of 4");
  });
});

describe("OpenAI-compatible embedding provider", () => {
  it("posts ordered inputs to a loopback endpoint without credentials", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 0, 0] },
        { index: 1, embedding: [0, 1, 0] }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "http://127.0.0.1:11434/v1/" }),
      { allowRemoteEmbeddings: false },
      { fetch, env: {} }
    );

    await expect(provider.embed(["first", "second"])).resolves.toEqual({
      vectors: [[1, 0, 0], [0, 1, 0]],
      dimension: 3,
      providerFingerprint: createProviderFingerprint(provider.endpointHash, "test-model", 3)
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "test-model", input: ["first", "second"] });
  });

  it("recognizes canonical IPv4-mapped IPv6 loopback addresses as local", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }]
    }), { status: 200 }));
    const provider = createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "http://[::ffff:127.0.0.1]:11434/v1" }),
      { allowRemoteEmbeddings: false },
      { fetch, env: {} }
    );

    expect(provider.isRemote).toBe(false);
    await expect(provider.embed(["local input"])).resolves.toMatchObject({ dimension: 2 });
    expect(fetch.mock.calls[0]![0]).toBe("http://[::ffff:7f00:1]:11434/v1/embeddings");
  });

  it("rejects remote endpoints unless privacy explicitly allows them", async () => {
    const fetch = vi.fn();
    expect(() => createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "https://embeddings.example/v1" }),
      { allowRemoteEmbeddings: false },
      { fetch }
    )).toThrow("Remote embeddings require privacy.allowRemoteEmbeddings=true");
    expect(() => createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "http://[::ffff:8.8.8.8]:11434/v1" }),
      { allowRemoteEmbeddings: false },
      { fetch }
    )).toThrow("Remote embeddings require privacy.allowRemoteEmbeddings=true");
    expect(() => createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "https://embeddings.example/v1" }),
      { allowRemoteEmbeddings: "false" } as unknown as { allowRemoteEmbeddings: boolean },
      { fetch }
    )).toThrow("Remote embeddings require privacy.allowRemoteEmbeddings=true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses HTTP redirects without forwarding the embedding body", async () => {
    const forwardedBodies: string[] = [];
    const target = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        forwardedBodies.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
      });
    });
    const redirect = createServer((_request, response) => {
      const targetPort = (target.address() as AddressInfo).port;
      response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/embeddings` });
      response.end();
    });
    await listen(target);
    await listen(redirect);
    try {
      const redirectPort = (redirect.address() as AddressInfo).port;
      const provider = createOpenAICompatibleEmbeddingProvider(
        embeddingConfig({ baseUrl: `http://127.0.0.1:${redirectPort}/v1` }),
        { allowRemoteEmbeddings: false }
      );

      await expect(provider.embed(["api_key=sk-proj-abcdefghijklmnop"])).rejects.toThrow(
        "Embedding request failed"
      );
      expect(forwardedBodies).toEqual([]);
    } finally {
      await Promise.all([closeServer(redirect), closeServer(target)]);
    }
  });

  it("redacts every remote input and sends authorization only from a configured non-empty env var", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] }
      ]
    }), { status: 200 }));
    const provider = createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ baseUrl: "https://embeddings.example/v1", apiKeyEnv: "EMBEDDING_KEY" }),
      { allowRemoteEmbeddings: true },
      { fetch, env: { EMBEDDING_KEY: "top-secret-key" } }
    );

    await provider.embed([
      "api_key=sk-proj-abcdefghijklmnop",
      "Bearer abc.def.ghi"
    ]);

    const init = fetch.mock.calls[0]![1]!;
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer top-secret-key"
    });
    const body = JSON.stringify(JSON.parse(String(init.body)));
    expect(body).toContain("[REDACTED:API_KEY]");
    expect(body).toContain("[REDACTED:BEARER_TOKEN]");
    expect(body).not.toContain("sk-proj-abcdefghijklmnop");
    expect(body).not.toContain("abc.def.ghi");
  });

  it.each([
    [{ data: [{ index: 0, embedding: [1, 2] }] }, "response count"],
    [{ data: [{ index: 1, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }] }, "response order"],
    [{ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }] }, "response dimension"]
  ])("rejects invalid %s without exposing the response", async (payload, expected) => {
    const rawBody = JSON.stringify({ ...payload, debug: "raw-response-secret" });
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(rawBody, { status: 200 }));
    const provider = createOpenAICompatibleEmbeddingProvider(
      embeddingConfig(),
      { allowRemoteEmbeddings: false },
      { fetch }
    );

    const error = await provider.embed(["private-input-1", "private-input-2"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("private-input");
    expect((error as Error).message).not.toContain("raw-response-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes HTTP and transport errors and never falls back to another endpoint", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response("raw-response-secret", { status: 503 })
    );
    const provider = createOpenAICompatibleEmbeddingProvider(
      embeddingConfig({ apiKeyEnv: "EMBEDDING_KEY" }),
      { allowRemoteEmbeddings: false },
      { fetch, env: { EMBEDDING_KEY: "top-secret-key" } }
    );

    const error = await provider.embed(["private-input"]).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("Embedding request failed with status 503");
    expect((error as Error).message).not.toContain("private-input");
    expect((error as Error).message).not.toContain("top-secret-key");
    expect((error as Error).message).not.toContain("raw-response-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:11434/v1/embeddings");
  });
});

function embeddingConfig(overrides: Partial<{
  baseUrl: string;
  apiKeyEnv: string;
}> = {}) {
  return {
    enabled: true,
    provider: "openai-compatible" as const,
    baseUrl: overrides.baseUrl ?? "http://127.0.0.1:11434/v1",
    model: "test-model",
    apiKeyEnv: overrides.apiKeyEnv,
    batchSize: 16
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
