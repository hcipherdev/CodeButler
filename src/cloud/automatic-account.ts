import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { readJson, serverUrl } from "./state.js";

export interface AutomaticAccountIdentity { server: string; accountId: string }
export interface AutomaticAccountContext {
  client: AccountClient;
  vaultId: string;
  assertCurrent: () => Promise<void>;
}
export class AutomaticAccountChangedError extends Error {
  constructor() { super("The signed-in account changed during automatic setup. Review this folder's connection."); }
}
function assertSelected(expected: AutomaticAccountIdentity): void {
  const selected = readJson<{ server: string }>(join(globalConfigDir(), "cloud", "account.json"));
  if (!selected?.server || serverUrl(selected.server) !== serverUrl(expected.server)) throw new AutomaticAccountChangedError();
}

/** A readiness operation keeps its original account even when another sign-in finishes. */
class AutomaticAccountClient extends AccountClient {
  constructor(readonly expected: AutomaticAccountIdentity) { super(expected.server); }
  override async tokens() {
    assertSelected(this.expected);
    const tokens = await super.tokens();
    if (tokens.accountId !== this.expected.accountId) throw new AutomaticAccountChangedError();
    assertSelected(this.expected);
    return tokens;
  }
}

export async function captureAutomaticAccount(expected: AutomaticAccountIdentity): Promise<AutomaticAccountContext> {
  const client = new AutomaticAccountClient(expected);
  const initial = await client.security.status();
  if (!initial.descriptor) throw new EncryptionError("enrollment-required");
  const vaultId = initial.descriptor.vaultId;
  const assertCurrent = async () => {
    assertSelected(expected);
    const tokens = await client.authSecurity.invoke<{ accountId: string } | null>("tokens-read");
    const current = await client.security.status();
    if (!tokens || tokens.accountId !== expected.accountId || current.descriptor?.accountId !== expected.accountId || current.descriptor.vaultId !== vaultId) throw new AutomaticAccountChangedError();
    assertSelected(expected);
  };
  await assertCurrent();
  return { client, vaultId, assertCurrent };
}
