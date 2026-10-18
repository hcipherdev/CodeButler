// Verifies queued automatic resume and legacy migration sync cannot undo a manual pause while waiting for the project gate.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { withProjectGate } from "../../src/cloud/gate.js";
import { saveBinding } from "../../src/cloud/state.js";
import { saveSecretBinding, secretBinding } from "../../src/secrets/state.js";
import { encryptedSecretsSync, resumeAccountSecrets, setSecretsSyncEnabled } from "../../src/secrets/sync.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

it("rechecks the enabled flag after a queued operation yields to a manual pause",async()=>{
  const root=makeTempDir("butler-secrets-pause-"),server="https://synthetic.invalid",parent=randomUUID(),vault=randomUUID();
  try {
    saveBinding(root,{projectId:parent,server,vaultId:vault,encryptionVersion:2,enabled:true,status:"ready",revision:0,fingerprint:"",checkoutId:randomUUID()});
    saveSecretBinding(root,{version:1,server,vaultId:randomUUID(),checkoutId:randomUUID(),enabled:true,status:"ready",revision:0});
    let entered:()=>void=()=>{},release:()=>void=()=>{};
    const inside=new Promise<void>(resolve=>{entered=resolve;}),readyToPause=new Promise<void>(resolve=>{release=resolve;});
    const foreground=withProjectGate(root,async()=>{entered();await readyToPause;return setSecretsSyncEnabled(root,false);},{name:"Synthetic foreground pause"});
    await inside;
    const resume=resumeAccountSecrets(root),legacySync=encryptedSecretsSync(root);
    release();
    const [,resumed,synced]=await Promise.all([foreground,resume,legacySync]);
    expect(resumed).toBeUndefined();expect(synced).toMatchObject({enabled:false,status:"disabled"});
    expect(secretBinding(root)).toMatchObject({enabled:false,status:"disabled"});
  } finally {cleanupTempDir(root);}
});
