// Tests AccountClient catalog capability checks before native vault state is accepted, and legacy compatibility.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountClient } from "../../src/cloud/account-client.js";
import type { NativeSecurity } from "../../src/cloud/native-security.js";
import { projectCatalogId } from "../../src/cloud/resource-identity.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function client(catalogEnabled: boolean, capability: unknown) {
  // status() is the device's own accepted history, read first to ask only for newer records; this device has none.
  const vaultId = randomUUID(), invoke = vi.fn(async () => capability), status = vi.fn(async () => ({ descriptor: null, records: [] }));
  const security = { invoke, status } as unknown as NativeSecurity;
  const c = new AccountClient("http://127.0.0.1", security);
  vi.spyOn(c, "tokens").mockResolvedValue({ accessToken: "test" } as Awaited<ReturnType<AccountClient["tokens"]>>);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ descriptor: { vaultId }, records: [{ record: { projects: catalogEnabled ? { [projectCatalogId(vaultId)]: 1 } : {} } }] }))));
  return { c, invoke };
}
describe("native catalog compatibility", () => {
  it("rejects a catalog-enabled vault before accepting its state with an older helper", async () => {
    const { c, invoke } = client(true, {});
    await expect(c.refreshVault()).rejects.toMatchObject({ state: "upgrade-required" });
    expect(invoke.mock.calls).toEqual([["capabilities"]]);
  });
  it("checks catalog support once per client and permits old vaults without the reserved resource", async () => {
    const { c, invoke } = client(true, { projectCatalog: 1 });
    await c.request("/v2/vault/state", "GET", undefined, false); await c.request("/v2/vault/state", "GET", undefined, false);
    expect(invoke).toHaveBeenCalledTimes(1);
    const legacy = client(false, {}); await legacy.c.request("/v2/vault/state", "GET", undefined, false);
    // Every account request negotiates the native secrets capability for the request header.
    expect(legacy.invoke.mock.calls).toEqual([["capabilities"]]);
  });
});
