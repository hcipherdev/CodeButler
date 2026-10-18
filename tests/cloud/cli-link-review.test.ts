// Tests CLI enforcement of interactive UUID recovery and the portable-fork review path, including marker-only checkouts.
import { randomUUID } from "node:crypto";
import { stdin, stderr } from "node:process";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSecureCloudCommand } from "../../src/cloud/secure-cli.js";
import { LinkReviewRequiredError } from "../../src/cloud/project-link-review.js";
import { atomicJson, binding, saveBinding, type Binding } from "../../src/cloud/state.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";
const cli=vi.hoisted(()=>({toggle:vi.fn(),review:vi.fn(),inspect:vi.fn(),sync:vi.fn()}));
vi.mock("../../src/cloud/account-client.js",()=>({AccountClient:class {constructor(readonly server:string){}}}));
vi.mock("../../src/cloud/sync-toggle.js",()=>({setEncryptedCloudSyncEnabled:cli.toggle}));
vi.mock("../../src/cloud/project-link-review.js",async original=>({...await original<Record<string,unknown>>(),reviewProjectLink:cli.review}));
vi.mock("../../src/cloud/project-connections.js",async original=>({...await original<Record<string,unknown>>(),inspectProjectConnection:cli.inspect}));
vi.mock("../../src/cloud/client.js",async original=>({...await original<Record<string,unknown>>(),cloudSync:cli.sync}));
const ttyDescriptors=[Object.getOwnPropertyDescriptor(stdin,"isTTY"),Object.getOwnPropertyDescriptor(stderr,"isTTY")];
const tty=(enabled:boolean)=>{Object.defineProperty(stdin,"isTTY",{configurable:true,value:enabled});Object.defineProperty(stderr,"isTTY",{configurable:true,value:enabled});};
let root:string,home:string,state:Binding,review:{record:{projectId:string};signature:string};
beforeEach(()=>{
  vi.resetAllMocks();root=makeTempDir();home=makeTempDir();vi.stubEnv("CODE_BUTLER_HOME",home);tty(false);
  atomicJson(join(home,"cloud","account.json"),{server:"https://example.test"});
  state={projectId:randomUUID(),vaultId:randomUUID(),checkoutId:randomUUID(),server:"https://example.test",encryptionVersion:2,enabled:true,status:"ready",revision:0,fingerprint:""};review={record:{projectId:state.projectId},signature:"x".repeat(88)};
  cli.toggle.mockImplementation(async(target,_enabled,options)=>{if(!options.confirmation)throw new LinkReviewRequiredError();saveBinding(target,state);return state;});
  cli.inspect.mockResolvedValue({projectId:state.projectId,recognition:"remote-changed"});
  cli.review.mockResolvedValue({review,projectId:state.projectId,label:"Expected project",root,remote:"github.com/owner/repo",summary:"Expected project summary.",memories:2,candidates:0,revision:1});cli.sync.mockResolvedValue(state);
});
afterEach(()=>{
  for(const [index,stream] of [stdin,stderr].entries()){const descriptor=ttyDescriptors[index];if(descriptor)Object.defineProperty(stream,"isTTY",descriptor);else Reflect.deleteProperty(stream,"isTTY");}
  vi.unstubAllEnvs();cleanupTempDir(root);cleanupTempDir(home);
});
it("refuses unverified --project links in noninteractive calls without requesting a confirmation or writing a binding",async()=>{
  const reader=vi.fn();await expect(runSecureCloudCommand(["enable","--project",state.projectId],root,vi.fn(),reader)).rejects.toThrow("reviewed confirmation");expect(reader).not.toHaveBeenCalled();expect(cli.review).not.toHaveBeenCalled();expect(binding(root)).toBeUndefined();
});
it("shows a summary and forwards the signed, typed confirmation through the shared enable path",async()=>{
  tty(true);const output=vi.fn();await runSecureCloudCommand(["enable","--project",state.projectId],root,output,async()=>state.projectId);
  expect(output.mock.calls.some(([text])=>String(text).includes("Expected project summary."))).toBe(true);
  expect(cli.toggle.mock.calls[1]![2]).toMatchObject({projectId:state.projectId,confirmation:{review,typedProjectId:state.projectId}});expect(binding(root)?.enabled).toBe(true);
});
it("does not change a connection when the typed UUID does not match",async()=>{
  tty(true);await expect(runSecureCloudCommand(["enable","--project",state.projectId],root,vi.fn(),async()=>randomUUID())).rejects.toThrow("cancelled");expect(cli.toggle).toHaveBeenCalledTimes(1);expect(binding(root)).toBeUndefined();
});
it("resolves a matching portable target for interactive fork sharing even before that clone is bound",async()=>{
  tty(true);await runSecureCloudCommand(["enable","--continue-existing"],root,vi.fn(),async()=>state.projectId);
  expect(cli.inspect).toHaveBeenCalled();expect(cli.review.mock.calls[0]!.slice(0,3)).toEqual([root,state.projectId,"share-remote"]);
  expect(cli.toggle.mock.calls[1]![2]).toMatchObject({approveRemote:true,confirmation:{review,typedProjectId:state.projectId}});
});
