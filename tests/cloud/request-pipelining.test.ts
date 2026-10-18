// Tests AccountClient.request() nonce pooling, retry after another process rotated the session token, and size-scaled timeouts (requestTimeout) in src/cloud/account-client.ts, EncryptedTransport.upload() parallel byte-bounded batches (transferBatches) in src/cloud/encrypted-client.ts, and download batch sizing (objectSizeEstimates) in src/cloud/encrypted-snapshot.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountClient, requestTimeout } from "../../src/cloud/account-client.js";
import { EncryptedTransport, TRANSFER_BATCH_BYTES, transferBatches, type PreparedPublication } from "../../src/cloud/encrypted-client.js";
import { EncryptionError } from "../../src/cloud/crypto-helper.js";
import { DEVICE_NONCE_EXPIRED } from "../../src/cloud/identity-protocol.js";
import type { NativeSecurity } from "../../src/cloud/native-security.js";
import { objectSizeEstimates, type ProjectTrust } from "../../src/cloud/encrypted-snapshot.js";
import { BLOCK_SIZE, SMALL_CORE_BLOCK_SIZE, type Snapshot } from "../../src/cloud/snapshot.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function client(nextNonces = true) {
  const proofs: string[] = [];
  const security = { invoke: async (operation: string, input: { nonce?: string }) => {
    if (operation === "proof") { proofs.push(input.nonce!); return { record: { nonce: input.nonce }, signature: "s" }; }
    return {};
  } } as unknown as NativeSecurity;
  const c = new AccountClient("http://127.0.0.1", security);
  let token = "token-a";
  vi.spyOn(c, "tokens").mockImplementation(async () => ({ accessToken: token, accountId: "account" }) as Awaited<ReturnType<AccountClient["tokens"]>>);
  let challenges = 0, issued = 0, sends = 0, failure: "none" | "nonce" | "other" = "none";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/v2/auth/device-challenge")) return new Response(JSON.stringify({ nonce: `challenge-${++challenges}` }));
    sends++;
    const proof = proofs.at(-1) ?? "";
    // A server rejects a stale nonce with a distinct message before running the request.
    if (failure === "nonce" && proof.startsWith("next-")) return new Response(JSON.stringify({ error: DEVICE_NONCE_EXPIRED, state: "verification-failed" }), { status: 403 });
    if (failure === "other") return new Response(JSON.stringify({ error: "verification-failed", state: "verification-failed" }), { status: 403 });
    return new Response(JSON.stringify({ ok: true }), { headers: nextNonces ? { "x-butler-next-nonce": `next-${++issued}` } : {} });
  }));
  return { c, proofs, challenges: () => challenges, sends: () => sends, setToken: (t: string) => { token = t; }, fail: (kind: "none" | "nonce" | "other") => { failure = kind; } };
}

describe("device proof nonces", () => {
  it("signs follow-up requests with the nonce returned by the previous response", async () => {
    const f = client();
    for (let i = 0; i < 3; i++) await f.c.request("/v2/projects/x/head");
    expect(f.challenges()).toBe(1);
    expect(f.proofs).toEqual(["challenge-1", "next-1", "next-2"]);
  });

  it("challenges on every request when the server returns no follow-up nonce", async () => {
    const f = client(false);
    for (let i = 0; i < 3; i++) await f.c.request("/v2/projects/x/head");
    expect(f.challenges()).toBe(3);
  });

  it("ignores pooled nonces that are stale or bound to another access token", async () => {
    const f = client(), now = Date.now();
    await f.c.request("/v2/projects/x/head");
    vi.spyOn(Date, "now").mockReturnValue(now + 46000);
    await f.c.request("/v2/projects/x/head");
    expect(f.challenges()).toBe(2);
    f.setToken("token-b");
    await f.c.request("/v2/projects/x/head");
    expect(f.challenges()).toBe(3);
  });

  it("retries once with a fresh challenge when the server reports the pooled nonce expired", async () => {
    const f = client();
    // Two concurrent requests leave two follow-up nonces pooled.
    await Promise.all([f.c.request("/v2/projects/x/head"), f.c.request("/v2/projects/x/head")]);
    f.fail("nonce");
    expect(await f.c.request("/v2/projects/x/publish", "POST", {})).toEqual({ ok: true });
    expect(f.proofs.slice(2)).toEqual(["next-1", "challenge-3"]);
    // The other stale nonce was discarded with the first; the retry's response refilled the pool.
    f.fail("none");
    await f.c.request("/v2/projects/x/head");
    expect(f.proofs.at(-1)).toBe("next-3");
    expect(f.challenges()).toBe(3);
  });

  it("never replays a request rejected for any other reason", async () => {
    const f = client();
    await f.c.request("/v2/projects/x/head");
    f.fail("other");
    await expect(f.c.request("/v2/projects/x/publish", "POST", {})).rejects.toBeInstanceOf(EncryptionError);
    expect(f.sends()).toBe(2);
  });
});

describe("parallel object upload", () => {
  function transport(failAt?: number, objectBytes = 10, count = 1000) {
    let active = 0, peak = 0, calls = 0; const stored = new Set<string>(), batchBytes: number[] = [];
    const request = vi.fn(async (_path: string, _method: string, body: Record<string, string>) => {
      const call = ++calls; active++; peak = Math.max(peak, active);
      batchBytes.push(Object.values(body).reduce((sum, value) => sum + Buffer.from(value, "base64").length, 0));
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (call === failAt) throw new EncryptionError("storage-full");
      for (const address of Object.keys(body)) stored.add(address);
      return { stored: Object.keys(body).length };
    });
    const t = new EncryptedTransport({ request } as unknown as AccountClient, { projectId: "p" } as ProjectTrust);
    const addresses = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, "0"));
    const prepared = { envelope: { objects: addresses }, objects: new Map(addresses.map(a => [a, Buffer.alloc(objectBytes)])) } as unknown as PreparedPublication;
    return { t, prepared, stored, batchBytes, peak: () => peak, calls: () => calls, active: () => active };
  }

  it("uploads every batch, a few at a time, and reports full progress", async () => {
    const f = transport(), progress: Array<[number, number]> = [];
    await f.t.upload(f.prepared, undefined, (sent, total) => progress.push([sent, total]));
    expect(f.stored.size).toBe(1000);
    expect(f.calls()).toBe(8);
    expect(f.peak()).toBe(3);
    expect(progress.at(-1)).toEqual([10000, 10000]);
  });

  it("stops starting batches after a failure and settles in-flight ones before rejecting", async () => {
    const f = transport(2);
    await expect(f.t.upload(f.prepared)).rejects.toMatchObject({ state: "storage-full" });
    expect(f.active()).toBe(0);
    expect(f.calls()).toBeLessThan(8);
  });

  it("bounds each request by encrypted bytes so full-size blocks never form an 11 MB request", async () => {
    const f = transport(undefined, 64 * 1024, 300);
    await f.t.upload(f.prepared);
    expect(f.stored.size).toBe(300);
    expect(Math.max(...f.batchBytes)).toBeLessThanOrEqual(TRANSFER_BATCH_BYTES);
    expect(f.calls()).toBe(Math.ceil(300 / (TRANSFER_BATCH_BYTES / (64 * 1024))));
  });

  it("keeps the server's 128-object cap and sends an oversized object alone", () => {
    expect(transferBatches(Array.from({ length: 300 }, (_, i) => i), () => 1).map(b => b.length)).toEqual([128, 128, 44]);
    expect(transferBatches([1, TRANSFER_BATCH_BYTES + 1, 1], size => size)).toEqual([[1], [TRANSFER_BATCH_BYTES + 1], [1]]);
    expect(transferBatches([], () => 1)).toEqual([]);
  });
});

describe("download batch sizing", () => {
  const hash = (n: number) => n.toString(16).padStart(64, "0");
  const segment = (kind: "core" | "file", blocks: string[], bytes: number) => ({ id: kind === "core" ? "core" : `file:${blocks[0]}`, kind, fingerprint: hash(0), blocks, bytes });
  it("bounds each object by the block size its segment was split with", () => {
    const small = [1, 2, 3].map(hash), large = [4, 5].map(hash), single = hash(6);
    const manifest = { segments: [segment("core", small, 2 * SMALL_CORE_BLOCK_SIZE + 100), segment("file", large, BLOCK_SIZE + 100), segment("file", [single], 100)] } as unknown as Snapshot;
    const sizes = objectSizeEstimates(manifest, Object.fromEntries([...small, ...large, single].map(h => [h, `a${h}`])));
    expect(small.map(h => sizes.get(`a${h}`)!)).toEqual(Array(3).fill(sizes.get(`a${small[0]}`)));
    expect(sizes.get(`a${small[0]}`)!).toBeGreaterThan(SMALL_CORE_BLOCK_SIZE);
    expect(sizes.get(`a${small[0]}`)!).toBeLessThan(SMALL_CORE_BLOCK_SIZE + 1024);
    expect(sizes.get(`a${large[0]}`)!).toBeGreaterThan(BLOCK_SIZE);
    expect(sizes.get(`a${single}`)!).toBeLessThan(1024);
  });

  it("packs about four times as many small core blocks per download request as full blocks", () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => hash(i + 1));
    const manifest = { segments: [segment("core", blocks, blocks.length * SMALL_CORE_BLOCK_SIZE)] } as unknown as Snapshot;
    const sizes = objectSizeEstimates(manifest, Object.fromEntries(blocks.map(h => [h, h])));
    const batches = transferBatches(blocks, h => sizes.get(h)!);
    expect(Math.max(...batches.map(b => b.reduce((sum, h) => sum + sizes.get(h)!, 0)))).toBeLessThanOrEqual(TRANSFER_BATCH_BYTES);
    expect(batches.length).toBeLessThanOrEqual(Math.ceil(transferBatches(blocks, () => BLOCK_SIZE).length / 3.5));
  });
});

describe("session token rotated by another process", () => {
  /** The server accepts only `current`, as after another process refreshed the shared session mid-request. */
  function rotating(rotateTo?: string) {
    const f = client(); let current = "token-a"; const used: string[] = [], calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      const bearer = init.headers.authorization?.slice(7) ?? "";
      calls.push(bearer);
      if (!url.endsWith("/v2/auth/device-challenge")) used.push(bearer);
      if (rotateTo && current === "token-a" && !url.endsWith("/v2/auth/device-challenge")) { current = rotateTo; f.setToken(rotateTo); }
      if (bearer !== current) return new Response(JSON.stringify({ error: "authentication-required", state: "authentication-required" }), { status: 401 });
      return new Response(JSON.stringify(url.endsWith("/v2/auth/device-challenge") ? { nonce: "challenge" } : { ok: true }));
    }));
    return { f, used, calls };
  }

  it("retries once with the token another process stored, when the in-flight request was refused", async () => {
    const { f, used } = rotating("token-b");
    await expect(f.c.request("/v2/projects/x/objects", "PUT", { a: "b" })).resolves.toEqual({ ok: true });
    expect(used).toEqual(["token-a", "token-b"]);
  });

  it("reports authentication-required when the stored token did not change", async () => {
    const { f, calls } = rotating();
    f.setToken("token-stale");
    await expect(f.c.request("/v2/projects/x/head")).rejects.toMatchObject({ state: "authentication-required" });
    // Refused at the device challenge, and not retried: the login itself is no longer valid.
    expect(calls).toEqual(["token-stale"]);
  });
});

describe("request timeouts", () => {
  it("keeps the base timeout for small requests and extends it for large uploads", () => {
    expect(requestTimeout(60000, 0)).toBe(60000);
    expect(requestTimeout(60000, 1024)).toBeLessThan(60100);
    expect(requestTimeout(60000, 3 * 1024 * 1024)).toBe(60000 + 48000);
  });

  it("reports an aborted request as a cloud timeout", async () => {
    const f = client();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/auth/device-challenge")) return new Response(JSON.stringify({ nonce: "challenge" }));
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));
    await expect(f.c.request("/v2/projects/x/head")).rejects.toThrow("Cloud request timed out; local memory remains available");
  });
});
