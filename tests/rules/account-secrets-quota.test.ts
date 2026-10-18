// Verifies global rules use an ordinary resource slot while account secrets companions consume no additional slots.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AccountClient } from "../../src/cloud/account-client.js";
import { projectCatalogId, secretsResourceId } from "../../src/cloud/resource-identity.js";
import { createEncryptedProject } from "../../src/cloud/vault-client.js";
import { setGlobalRulesSyncEnabled } from "../../src/rules/sync.js";
import { globalRulesProjectId } from "../../src/rules/identity.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

vi.mock("../../src/cloud/vault-client.js", async original => ({
  ...await original<typeof import("../../src/cloud/vault-client.js")>(),
  createEncryptedProject: vi.fn(async (_client: AccountClient, id: string) => id)
}));
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); directories.splice(0).forEach(cleanupTempDir); });
function fixture(parentCount: number) {
  const directory = makeTempDir(); directories.push(directory); vi.stubEnv("CODE_BUTLER_HOME", directory);
  const vaultId = randomUUID(), parents = Array.from({ length: parentCount }, () => randomUUID());
  const projects = Object.fromEntries([projectCatalogId(vaultId), ...parents, ...parents.map(secretsResourceId)].map(id => [id, 1]));
  const client = { server: "http://127.0.0.1", refreshVault: vi.fn(async () => ({ descriptor: { vaultId }, projects })) } as unknown as AccountClient;
  return { client, vaultId };
}
it("enables the tenth ordinary resource even with nine secrets companions", async () => {
  const f = fixture(9);
  expect(await setGlobalRulesSyncEnabled(true, f.client)).toMatchObject({ enabled: true, projectId: globalRulesProjectId(f.vaultId) });
  expect(createEncryptedProject).toHaveBeenCalledWith(f.client, globalRulesProjectId(f.vaultId));
});
it("keeps the existing ten-slot limit when ten parent projects are present", async () => {
  const f = fixture(10);
  await expect(setGlobalRulesSyncEnabled(true, f.client)).rejects.toThrow("one project slot");
  expect(createEncryptedProject).not.toHaveBeenCalled();
});
