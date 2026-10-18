// Tests signed recovery evidence, verified-only inspection, unrelated-identity rejection, stale reviews, and data preservation through the shared linker.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountClient } from "../../src/cloud/account-client.js";
import { EncryptedTransport } from "../../src/cloud/encrypted-client.js";
import { canonical, verifyDocument } from "../../src/cloud/identity-protocol.js";
import { connectCloudProject, inspectProjectConnection } from "../../src/cloud/project-connections.js";
import { reviewProjectLink, type LinkConfirmation } from "../../src/cloud/project-link-review.js";
import { ensureProjectIdentity, PROJECT_IDENTITY_FILE, readProjectIdentity } from "../../src/cloud/project-identity.js";
import { binding, saveBinding } from "../../src/cloud/state.js";
import { captureSnapshot, databaseFingerprint } from "../../src/cloud/snapshot.js";
import { projectCatalogId } from "../../src/cloud/resource-identity.js";
import type { CatalogView } from "../../src/cloud/project-catalog.js";
import { openConfiguredMemoryStore } from "../../src/storage/open-configured-store.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { ensureProjectConfig } from "../../src/config.js";
import { gitExecutable } from "../../src/git-executable.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const catalog = vi.hoisted(() => ({ account: vi.fn(), read: vi.fn(), cached: vi.fn(), reserve: vi.fn(), activate: vi.fn() }));
vi.mock("../../src/cloud/project-catalog.js", async original => ({...await original<Record<string,unknown>>(), catalogAccount: catalog.account, readProjectCatalog: catalog.read, cachedProjectCatalog: catalog.cached, requireCatalogCapabilities: vi.fn(), reserveCatalogProject: catalog.reserve, activateCatalogProject: catalog.activate }));
vi.mock("../../src/cloud/vault-client.js", async original => ({...await original<Record<string,unknown>>(),createEncryptedProject:vi.fn(async (_c,id)=>id),projectTrust:vi.fn((_s,id)=>({projectId:id}))}));
const roots: string[]=[];
const temp=()=>{const root=makeTempDir();roots.push(root);return root;};
let root:string, projectId:string, vaultId:string, client:AccountClient, view:CatalogView, status:{descriptor:{accountId:string;vaultId:string};device:{signingKey:string}}, pin:{revision:number;commitment:string};
function git(remote:string) { const result=spawnSync(gitExecutable(),["-C",root,"init"],{encoding:"utf8",windowsHide:true});if(result.status!==0)throw new Error(result.stderr); const added=spawnSync(gitExecutable(),["-C",root,"remote","add","origin",remote],{encoding:"utf8",windowsHide:true});if(added.status!==0)throw new Error(added.stderr); }
function unchanged() {
  const marker=join(root,PROJECT_IDENTITY_FILE),db=join(root,".code-butler","memory.sqlite");
  return {marker:existsSync(marker)?readFileSync(marker,"utf8"):null,binding:binding(root)??null,catalog:JSON.stringify(view.catalog),memory:existsSync(db)?databaseFingerprint(db):null};
}
const confirmed=async(intent:"recover"|"share-remote"="recover"):Promise<LinkConfirmation>=>({review:(await reviewProjectLink(root,projectId,intent,client)).review,typedProjectId:projectId});
beforeEach(()=>{
  vi.resetAllMocks(); vi.stubEnv("CODE_BUTLER_HOME",temp());root=temp();ensureProjectConfig(root);projectId=randomUUID();vaultId=randomUUID();pin={revision:0,commitment:""};
  const keys=generateKeyPairSync("ed25519"),signingKey=keys.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
  status={descriptor:{accountId:randomUUID(),vaultId},device:{signingKey}};
  view={catalog:{version:1,entries:{}},projects:[{id:projectId},{id:randomUUID()}],stale:false};
  const security={status:async()=>status,signDocument:async(record:unknown)=>({record,signature:sign(null,Buffer.concat([Buffer.from("code-butler/identity/v1\0"),Buffer.from(canonical(record))]),keys.privateKey).toString("base64")}),verifyDocument:async(document:Parameters<typeof verifyDocument>[0],key:string)=>verifyDocument(document,key)};
  client={server:"https://example.test",security,request:vi.fn(async()=>pin)} as unknown as AccountClient;
  catalog.account.mockImplementation(async()=>status); catalog.read.mockImplementation(async()=>view);catalog.cached.mockImplementation(async()=>view);
  catalog.reserve.mockImplementation(async(_client,identity,label,remote,requested)=>{const entry={projectId:requested??projectId,label,remoteHints:[remote],state:"active" as const};view.catalog.entries[identity]=entry;return {...entry,projectIdentity:identity};});
  vi.spyOn(EncryptedTransport.prototype,"pull").mockResolvedValue(undefined);vi.spyOn(EncryptedTransport.prototype,"head").mockImplementation(async()=>pin);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const path of roots.splice(0))cleanupTempDir(path);});

describe("shared project linking safeguards",()=>{
  it("keeps account inventory out of inspection and does not treat a remote suggestion as identity",async()=>{
    git("https://github.com/owner/repo.git");view.catalog.entries[randomUUID()]={projectId,label:"Suggested repository",remoteHints:["github.com/owner/repo"],state:"active"};
    const inspection=await inspectProjectConnection(root,true,client);expect(inspection).toMatchObject({recognition:"unlinked",provenance:"none",projects:[]});expect(inspection.suggestions).toHaveLength(1);
    const before=unchanged();await expect(connectCloudProject(root,{projectId,client})).rejects.toThrow("reviewed confirmation");expect(unchanged()).toEqual(before);expect(catalog.reserve).not.toHaveBeenCalled();
  });
  it("shows only the marker's verified target and reconnects without a recovery picker",async()=>{
    const marker=ensureProjectIdentity(root);view.catalog.entries[marker.projectIdentity]={projectId,label:"Matching memory",remoteHints:[],state:"active"};
    expect(await inspectProjectConnection(root,true,client)).toMatchObject({recognition:"existing",provenance:"portable-marker",projects:[{id:projectId}]});
    const linked=await connectCloudProject(root,{client});expect(linked.projectId).toBe(projectId);expect(linked.enabled).toBe(false);
  });
  it("accepts signed, typed legacy recovery and preserves populated local memory",async()=>{
    const store=openConfiguredMemoryStore(root);store.init();rememberProjectMemory(store,{type:"decision",text:"Keep this local repository decision.",scope:{kind:"project"}});store.close();
    const before=unchanged(),confirmation=await confirmed();expect(unchanged()).toEqual(before);
    const linked=await connectCloudProject(root,{projectId,client,confirmation});expect(linked.projectId).toBe(projectId);expect(linked.enabled).toBe(false);expect(linked.fingerprint).toBe("");expect(unchanged().memory).toBe(before.memory);
    expect(readProjectIdentity(root)).toBeDefined();expect(catalog.reserve).toHaveBeenCalledTimes(1);
    await expect(connectCloudProject(root,{projectId,client,confirmation})).rejects.toThrow("stale");
  });
  it("can deliberately recover a legacy UUID using an unmapped portable marker",async()=>{
    const marker=ensureProjectIdentity(root),before=unchanged();
    await expect(connectCloudProject(root,{projectId,client})).rejects.toThrow("reviewed confirmation");expect(unchanged()).toEqual(before);
    const confirmation=await confirmed();const linked=await connectCloudProject(root,{projectId,client,confirmation});expect(linked.projectIdentity).toBe(marker.projectIdentity);
  });
  it("shows the actual cloud summary and authored memory counts in a read-only review",async()=>{
    const cloudRoot=temp(),store=openConfiguredMemoryStore(cloudRoot);store.init();rememberProjectMemory(store,{type:"decision",text:"Actual cloud content.",scope:{kind:"project"}});store.close();
    writeFileSync(join(cloudRoot,".code-butler","project-summary.md"),"# Expected repository\nCloud repository summary.");
    const snapshot=await captureSnapshot(cloudRoot,projectId,0,randomUUID());pin={revision:3,commitment:"a".repeat(64)};
    vi.mocked(EncryptedTransport.prototype.pull).mockResolvedValue({pin,bundle:{manifest:snapshot.snapshot,blocks:snapshot.blocks}} as Awaited<ReturnType<EncryptedTransport["pull"]>>);
    const before=unchanged(),review=await reviewProjectLink(root,projectId,"recover",client);expect(review).toMatchObject({memories:1,summary:"# Expected repository\nCloud repository summary.",revision:3,projectId});expect(unchanged()).toEqual(before);
  });
  it.each(["UUID","local-memory","marker","account","revision","catalog","expiry","signature"])("rejects %s changes without altering a marker, binding, catalog or memory",async(reason)=>{
    const confirmation=await confirmed();
    if(reason==="UUID")confirmation.typedProjectId=randomUUID();
    if(reason==="local-memory")writeFileSync(join(root,".code-butler","project-summary.md"),"Changed after review.");
    if(reason==="marker")ensureProjectIdentity(root);
    if(reason==="account")status.descriptor.accountId=randomUUID();
    if(reason==="revision")pin={revision:1,commitment:"c".repeat(64)};
    if(reason==="catalog")view.catalog.entries[randomUUID()]={projectId:view.projects[1]!.id,label:"New catalog entry",state:"active",remoteHints:[]};
    if(reason==="expiry")vi.spyOn(Date,"now").mockReturnValue(Date.now()+11*60_000);
    if(reason==="signature")confirmation.review.record.remote="forged-remote";
    const before=unchanged();await expect(connectCloudProject(root,{projectId,client,confirmation})).rejects.toThrow();expect(unchanged()).toEqual(before);expect(catalog.reserve).not.toHaveBeenCalled();
  });
  it("rejects another marker, unrelated approved remotes, and reserved resources before linking",async()=>{
    const marker=ensureProjectIdentity(root);view.catalog.entries[randomUUID()]={projectId,label:"Other repository",state:"active",remoteHints:[]};let before=unchanged();
    await expect(connectCloudProject(root,{projectId,client})).rejects.toThrow("another portable project identity");expect(unchanged()).toEqual(before);
    view.catalog.entries={[marker.projectIdentity]:{projectId,label:"Expected repository",state:"active",remoteHints:["github.com/owner/expected"]}};git("https://github.com/owner/unrelated.git");before=unchanged();
    await expect(reviewProjectLink(root,projectId,"recover",client)).rejects.toThrow("another Git repository");expect(unchanged()).toEqual(before);
    const reserved=projectCatalogId(vaultId);view.projects.push({id:reserved});await expect(reviewProjectLink(root,reserved,"recover",client)).rejects.toThrow("unavailable");expect(unchanged()).toEqual(before);
  });
  it("requires reviewed matching identity for intentional fork sharing and records the approved alias",async()=>{
    const marker=ensureProjectIdentity(root);git("https://github.com/fork/repo.git");view.catalog.entries[marker.projectIdentity]={projectId,label:"Shared memory",state:"active",remoteHints:["github.com/owner/repo"]};const before=unchanged();
    await expect(connectCloudProject(root,{client,approveRemote:true})).rejects.toThrow("reviewed confirmation");expect(unchanged()).toEqual(before);
    const confirmation=await confirmed("share-remote");expect((await connectCloudProject(root,{client,approveRemote:true,confirmation})).projectId).toBe(projectId);
  });
  it("resumes a saved binding without changing its checkout ID or enabled state during portable publication",async()=>{
    const checkoutId=randomUUID();saveBinding(root,{projectId,vaultId,checkoutId,server:client.server,encryptionVersion:2,enabled:true,revision:4,fingerprint:"x",status:"conflict"});
    const linked=await connectCloudProject(root,{projectId,client});expect(linked).toMatchObject({projectId,checkoutId,enabled:true,revision:4,status:"conflict"});
  });
});
