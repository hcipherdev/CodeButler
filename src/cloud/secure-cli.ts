import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { stderr, stdin } from "node:process";
import { z } from "zod";
import { globalConfigDir } from "../config.js";
import { AccountClient } from "./account-client.js";
import { cloudSync } from "./client.js";
import { EncryptionError } from "./crypto-helper.js";
import { restoreRecovery, rotateVault } from "./vault-client.js";
import { reviewProjectConflict, resolveProjectConflict } from "./project-review.js";
import { setEncryptedCloudSyncEnabled } from "./sync-toggle.js";
import { cloudProjectList, makeProjectPortable, separateProjectIdentity, inspectProjectConnection } from "./project-connections.js";
import { atomicJson, binding, readJson, serverUrl, UUID } from "./state.js";
import { migrateCheckout } from "./checkout-repair.js";
import { LinkReviewRequiredError, reviewProjectLink } from "./project-link-review.js";

const selectionPath = () => join(globalConfigDir(),"cloud","account.json");
function writeNew(path: string, value: string): void {
  const target=resolve(path);
  if(existsSync(target)){if(readFileSync(target,"utf8")===value)return;throw new Error("Recovery output file already exists with different contents");}
  writeFileSync(target,value,{flag:"wx",mode:0o600});
}
import { cloudStorageReport, localStorageReport } from "./storage-diagnostics.js";

export async function runSecureCloudCommand(args:string[],root:string,output:(line:string)=>void,secretReader:()=>Promise<string>):Promise<number> {
  if (existsSync(root)) migrateCheckout(root);
  const [command,...rest]=args;
  const sub = ["device","recovery"].includes(command ?? "") ? rest.shift() : undefined;
  const action=sub ? `${command} ${sub}` : command;
  const allowed:Record<string,string[]>={
    register:["--server","--email"],login:["--server","--email","--method"],logout:[],init:["--label","--recovery-file","--recovery-code-file"],
    "device request":["--label"],"device approve":["--request","--fingerprint"],"device complete":["--request","--fingerprint"],"device cancel":["--request"],"device list":[],"device revoke":["--device"],
    "recovery export":["--file"],"recovery verify":["--file"],"recovery restore":["--file","--label"],
    enable:["--project","--name","--new","--continue-existing"],"make-portable":["--continue-existing"],"separate-identity":[],projects:[],sync:[],storage:[],"local-size":[],status:[],resolve:["--keep"],disable:[]
  };
  if(!action || !allowed[action]) throw new Error("Usage: code-butler cloud <register|login|logout|init|device|recovery|enable|make-portable|separate-identity|projects|sync|status|resolve|disable>");
  const flags=new Map<string,string>();
  for(let i=0;i<rest.length;i++) {
    const key=rest[i]!,value=["--new","--continue-existing"].includes(key)?"true":rest[++i];
    if(!allowed[action]!.includes(key)||!value||flags.has(key)) throw new Error("Invalid cloud command options"); flags.set(key,value);
  }
  if (flags.has("--new") && flags.has("--project")) throw new Error("Choose --new or --project, not both");
  const required=(key:string)=>{const value=flags.get(key);if(!value) throw new Error(`Required option: ${key}`);return value;};
  if(action==="storage") {output(JSON.stringify(await cloudStorageReport(root),null,2));return 0;}
  if(action==="local-size") {output(JSON.stringify(await localStorageReport(root),null,2));return 0;}
  if(action==="status") { output(JSON.stringify(binding(root) ?? {enabled:false},null,2));return 0; }
  if(action==="separate-identity") { output(JSON.stringify(await separateProjectIdentity(root))); return 0; }
  if(action==="disable") {
    await setEncryptedCloudSyncEnabled(root, false);
    output("Cloud sync disabled; local memories retained.");return 0;
  }
  const saved=readJson<{server:string}>(selectionPath());
  const server=serverUrl(flags.get("--server") ?? saved?.server ?? (()=>{throw new EncryptionError("authentication-required");})());
  const client=new AccountClient(server);
  if(action==="register") {
    const challenge=await client.challenge(required("--email"),"register");
    output("Enter the eight-digit email verification code through the hidden prompt or stdin.");
    const code=await secretReader();
    output("Enter a new password of at least 15 UTF-8 bytes through the hidden prompt or stdin.");
    await client.register(challenge.challengeId,code,await secretReader()); atomicJson(selectionPath(),{server});
    output("Account authenticated. Add a passkey in the desktop Account Center, then initialize or enroll this device.");return 0;
  }
  if(action==="login") {
    if(flags.get("--method")==="code") {
      const challenge=await client.challenge(required("--email"),"login");
      output("Enter the eight-digit email code through the hidden prompt or stdin.");
      await client.login(challenge.challengeId,await secretReader());
    } else if(!flags.has("--method") || flags.get("--method")==="password") {
      output("Enter your account password through the hidden prompt or stdin.");
      await client.passwordLogin(required("--email"),await secretReader());
    } else throw new Error("Use --method password or --method code");
    atomicJson(selectionPath(),{server});
    output("Account authenticated. Initialize a vault or enroll this device to synchronize memories.");return 0;
  }
  if(action==="logout") {const revoked=await client.logout();output(revoked?"Signed out. Local memories retained.":"Signed out locally. Server revocation could not be confirmed; local memories retained.");return 0;}
  if(action==="init") {
    const status=await client.initialize(flags.get("--label") ?? hostname());
    if(!status.recoveryReady) {
      const kitPath=required("--recovery-file");
      if(!stderr.isTTY&&!flags.has("--recovery-code-file")) throw new Error("Noninteractive setup requires --recovery-code-file for protected recovery-code output");
      const exported=await client.security.invoke<{kit:unknown;code:string}>("recovery-export");
      writeNew(kitPath,JSON.stringify(exported.kit));
      if(flags.has("--recovery-code-file")) writeNew(required("--recovery-code-file"),`${exported.code}\n`);
      else stderr.write(`Save this recovery code separately from the recovery file:\n${exported.code}\n`);
      await client.security.invoke("recovery-confirm",{kit:JSON.parse(readFileSync(resolve(kitPath),"utf8")),code:exported.code});
    }
    await client.publishInitialization();output("Encrypted vault initialized. Store the recovery file and code safely offline.");return 0;
  }
  if(action==="device request") {output(JSON.stringify(await client.enrollmentRequestAnchored(flags.get("--label")??hostname()),null,2));output("Enter the device fingerprint in Account Center on an approved computer. The desktop completes enrollment automatically.");return 0;}
  if(action==="device approve") {
    if (flags.has("--request")) {
      output(JSON.stringify(await client.approve(UUID.parse(required("--request")),required("--fingerprint")),null,2));
      output("Legacy enrollment: compare this vault fingerprint on the new device before completing enrollment.");
    } else { output(JSON.stringify(await client.approveFingerprint(required("--fingerprint")),null,2)); output("Approved. The new desktop finishes connecting automatically."); }
    return 0;
  }
  if(action==="device complete") {
    if (flags.has("--request") || flags.has("--fingerprint")) {
      await client.complete(UUID.parse(required("--request")),required("--fingerprint")); output("Device enrolled.");
    } else output(JSON.stringify(await client.enrollmentProgress(),null,2));
    return 0;
  }
  if(action==="device cancel") {await client.request(`/v2/vault/enrollment/${UUID.parse(required("--request"))}/cancel`,"POST",undefined,false);output("Pairing cancelled.");return 0;}
  if(action==="device list") {await client.refreshVault();output(JSON.stringify(await client.request("/v2/vault/devices"),null,2));return 0;}
  if(action==="device revoke") {await rotateVault(client,UUID.parse(required("--device")));output("Device removed; project key rotation completed.");return 0;}
  if(action==="recovery export") {
    const kit=await client.security.invoke<unknown>("kit-read");if(!kit) throw new EncryptionError("recovery-required");
    writeNew(required("--file"),JSON.stringify(kit));output("Encrypted recovery file exported. Use its existing recovery code.");return 0;
  }
  if(action==="recovery verify") {
    output("Enter the recovery code through the hidden prompt or stdin.");
    await client.security.invoke("recovery-verify",{kit:JSON.parse(readFileSync(resolve(required("--file")),"utf8")),code:await secretReader()});output("Recovery file verified.");return 0;
  }
  if(action==="recovery restore") {
    output("Enter the recovery code through the hidden prompt or stdin.");
    await restoreRecovery(client,resolve(required("--file")),await secretReader(),flags.get("--label")??hostname());
    output("Recovery completed; previous device membership replaced and project keys rotated.");return 0;
  }
  if(action==="projects") {
    output(JSON.stringify(await cloudProjectList(true, client), null, 2)); return 0;
  }
  if(action==="make-portable") { output(JSON.stringify(await makeProjectPortable(root,flags.has("--continue-existing"),client),null,2));return 0; }
  if(action==="enable") {
    const options = {client,createNew:flags.has("--new"),approveRemote:flags.has("--continue-existing"),...(flags.has("--project")?{projectId:UUID.parse(required("--project"))}:{}),...(flags.has("--name")?{label:required("--name")}:{} )};
    try { await setEncryptedCloudSyncEnabled(root,true,options); }
    catch (error) {
      if (!(error instanceof LinkReviewRequiredError) || !stdin.isTTY || !stderr.isTTY) throw error;
      const projectId = options.projectId ?? binding(root)?.projectId ?? (await inspectProjectConnection(root,true,client)).projectId;
      if (!projectId) throw error;
      const preview = await reviewProjectLink(root, projectId, options.approveRemote ? "share-remote" : "recover", client);
      const { review, ...details } = preview;
      output(JSON.stringify(details,null,2));
      output(`Review this cloud memory, then type its exact project ID (${projectId}) to confirm. An empty answer cancels.`);
      const typedProjectId = (await secretReader()).trim();
      if (typedProjectId !== projectId) throw new Error("Connection recovery cancelled; the project ID was not confirmed.");
      await setEncryptedCloudSyncEnabled(root,true,{...options,confirmation:{review,typedProjectId}});
    }
    output("Encrypted cloud sync enabled. Restart existing MCP sessions to allow automatic restores.");
  }
  if(!binding(root)?.enabled||binding(root)?.encryptionVersion!==2) throw new Error("Enable a fresh encrypted project with code-butler cloud enable");
  const keep=action==="resolve"?z.enum(["local","cloud","merge"]).parse(required("--keep")):undefined;
  output(JSON.stringify(keep ? await resolveProjectConflict(root,keep,await reviewProjectConflict(root,client),client) : await cloudSync(root),null,2));return 0;
}
