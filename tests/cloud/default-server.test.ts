// Tests defaultCloudServer() in src/cloud/state.ts, the register/login server fallback in src/cloud/secure-cli.ts and the signed-out server in src/desktop/account.ts.
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSecureCloudCommand } from "../../src/cloud/secure-cli.js";
import { atomicJson, DEFAULT_CLOUD_SERVER, defaultCloudServer } from "../../src/cloud/state.js";
import { localAccountStatus } from "../../src/desktop/account.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";
const servers=vi.hoisted(()=>[] as string[]);
vi.mock("../../src/cloud/account-client.js",()=>({AccountClient:class {
  constructor(readonly server:string){servers.push(server);}
  async challenge(){return {challengeId:"c",expiresAt:0};}
  async register(){}
  async passwordLogin(){}
}}));
let root:string,home:string;
beforeEach(()=>{servers.length=0;root=makeTempDir();home=makeTempDir();vi.stubEnv("CODE_BUTLER_HOME",home);vi.stubEnv("CODE_BUTLER_CLOUD_SERVER","");});
afterEach(()=>{vi.unstubAllEnvs();cleanupTempDir(root);cleanupTempDir(home);});
const secrets=async()=>"x".repeat(15);
it("uses the hosted service unless CODE_BUTLER_CLOUD_SERVER overrides it",()=>{
  expect(defaultCloudServer()).toBe("https://cloud.codebutler.dev");
  vi.stubEnv("CODE_BUTLER_CLOUD_SERVER","http://localhost:8788");expect(defaultCloudServer()).toBe("http://localhost:8788");
  vi.stubEnv("CODE_BUTLER_CLOUD_SERVER","http://example.test");expect(()=>defaultCloudServer()).toThrow("HTTPS");
});
it("registers and logs in against the hosted service when no server is given or saved",async()=>{
  await runSecureCloudCommand(["register","--email","a@example.com"],root,vi.fn(),secrets);
  await runSecureCloudCommand(["login","--email","a@example.com"],root,vi.fn(),secrets);
  expect(servers).toEqual([DEFAULT_CLOUD_SERVER,DEFAULT_CLOUD_SERVER]);
});
it("prefers --server, then the saved server, over the default",async()=>{
  atomicJson(join(home,"cloud","account.json"),{server:"https://saved.example"});
  await runSecureCloudCommand(["login","--email","a@example.com"],root,vi.fn(),secrets);
  await runSecureCloudCommand(["login","--email","a@example.com","--server","https://flag.example"],root,vi.fn(),secrets);
  expect(servers).toEqual(["https://saved.example","https://flag.example"]);
});
it("does not fall back to the default for commands that need an existing session",async()=>{
  await expect(runSecureCloudCommand(["logout"],root,vi.fn(),secrets)).rejects.toMatchObject({state:"authentication-required"});
  expect(servers).toEqual([]);
});
it("reports the default server while the desktop app is signed out",async()=>{
  expect(await localAccountStatus()).toMatchObject({signedIn:false,server:DEFAULT_CLOUD_SERVER});
});
