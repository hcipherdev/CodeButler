import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSecurity, nativeExecutable } from "../../dist/cloud/native-security.js";
import { documentHash } from "../../dist/cloud/identity-protocol.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const executable = nativeExecutable();
assert.equal(dirname(executable), join(root, "dist", "native", `${process.platform}-${process.arch}`));
const temporaryRoot = resolve(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, "butler-package-"));
try {
  const first = new NativeSecurity(join(directory, "first"));
  const recovered = new NativeSecurity(join(directory, "recovered"));
  assert.equal((await first.invoke("capabilities")).projectCatalog, 1);
  assert.equal(existsSync(first.directory), false);
  const accountId = randomUUID();
  const initial = await first.invoke("initialize", {
    accountId, vaultId: randomUUID(), deviceId: randomUUID(),
    installationId: randomUUID(), label: "Package verification"
  });
  const kit = await first.invoke("recovery-export");
  await first.invoke("recovery-confirm", kit);
  assert.equal((await first.status()).recoveryReady, true);
  // Recover before any projects exist, then verify the recovered device can
  // export the same offline kit after it has discarded recovery private keys.
  await recovered.invoke("recovery-load", {
    ...kit, accountId, records: initial.records, deviceId: randomUUID(),
    installationId: randomUUID(), label: "Recovered package verification"
  });
  const record = await recovered.invoke("rotation-stage");
  await recovered.invoke("stage-commit", { commitment: documentHash(record) });
  assert.deepEqual(await recovered.invoke("kit-read"), kit.kit);
  await recovered.invoke("recovery-verify", kit);
  assert.equal((await recovered.status()).records.at(-1).record.devices.length, 1);
  console.log("Packaged native helper passed catalog capability, secure-storage, initialization and recovery checks.");
} finally {
  if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("Invalid package verification directory");
  rmSync(directory, { recursive: true, force: true });
}
