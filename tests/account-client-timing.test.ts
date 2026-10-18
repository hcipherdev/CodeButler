import { afterEach, expect, it, vi } from "vitest";
import { AccountClient } from "../src/cloud/account-client.js";
import type { NativeSecurity } from "../src/cloud/native-security.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("records request and response sizes without changing the account response", async () => {
  const client = new AccountClient("http://127.0.0.1", { invoke: async () => ({ projectCatalog: 1, deviceEnrollment: 2, accountSecrets: 1 }) } as unknown as NativeSecurity);
  vi.spyOn(client, "tokens").mockResolvedValue({ accessToken: "test" } as Awaited<ReturnType<AccountClient["tokens"]>>);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" }
  })));
  expect(await client.request<{ ok: boolean }>("/v2/test", "POST", { hello: "world" }, false)).toEqual({ ok: true });
  expect(client.networkTiming.uploadedBytes).toBeGreaterThan(0);
  expect(client.networkTiming.downloadedBytes).toBeGreaterThan(0);
  expect(client.networkTiming.milliseconds).toBeGreaterThanOrEqual(0);
});
