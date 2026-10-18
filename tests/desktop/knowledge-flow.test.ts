// Tests the complete desktop handbook, history, approved wording, and export flow in an isolated project.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ensureProjectConfig } from "../../src/config.js";
import { registerWatchedProject } from "../../src/global-watch.js";
import { activeForegroundIntent } from "../../src/cloud/foreground.js";
import { handleDesktopRequest, runDesktopMemoryReview } from "../../src/desktop/service.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { updateMemoryStatus } from "../../src/memory/lifecycle-service.js";
import { openMemoryStore } from "../../src/storage/store.js";
import type { Topic } from "../../src/memory/topics.js";
import type { WordingRun } from "../../src/memory/wording.js";
import type { MemoryReconciliationProvider } from "../../src/memory/reconciliation-provider.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

it("finishes the desktop memory workflow without touching live project data", async () => {
  const directory=makeTempDir(),root=join(directory,"project"),home=join(directory,"home");
  vi.stubEnv("CODE_BUTLER_HOME",home);vi.stubEnv("CODE_BUTLER_RETRIEVAL_ENGINE","legacy");vi.stubEnv("BUTLER_TEST_AI_KEY","test-only-key");mkdirSync(root);
  const call=<T=unknown>(action:string,input:Record<string,unknown>={},version=1)=>handleDesktopRequest({version,action,root,...input}) as Promise<T>;
  try {
    ensureProjectConfig(root);registerWatchedProject(root);
    writeFileSync(join(home,"config.json"),JSON.stringify({investigator:{enabled:true,provider:"openai-compatible",model:"fixture-wording",apiKeyEnv:"BUTLER_TEST_AI_KEY"}}));
    const store=openMemoryStore(root);store.init();
    let durable:string,candidate:string,prior:string;
    try {
      durable=rememberProjectMemory(store,{type:"decision",text:"Use local storage for project memory.",relatedFiles:["src/storage/store.ts"],scope:{kind:"project"},statement:{fields:{choice:"Local storage",rationale:"Support offline work."}}}).memory!.id;
      candidate=rememberProjectMemory(store,{type:"constraint",text:"Keep sync keys on this device.",promote:false,scope:{kind:"project"}}).candidate.id;
      prior=rememberProjectMemory(store,{type:"decision",text:"Use the previous storage layout.",scope:{kind:"project"}}).memory!.id;
      updateMemoryStatus(store,{memoryId:prior,status:"superseded",replacementMemoryId:durable,reason:"Support the current storage layout",now:new Date().toISOString()});
    } finally {store.close();}
    await expect(call("memory.tiers",{},2)).resolves.toMatchObject({movement7d:{madeDurable:2,replaced:1,partialSharingHistory:true}});
    await expect(call("memory.history",{id:durable,category:"promoted"})).resolves.toMatchObject({items:expect.arrayContaining([expect.objectContaining({kind:"replaced",from:expect.objectContaining({id:prior}),to:expect.objectContaining({id:durable})})])});
    await expect(call("memory.topics.suggest")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({prefixes:["src/storage"]})]));
    await expect(call("memory.topic.preview",{prefixes:["src/storage"],layer:"core"})).resolves.toMatchObject({total:1});
    const topic=await call<Topic>("memory.topic.save",{name:"Storage",introduction:"How project memory is stored.",prefixes:["src/storage"]});
    await expect(call("memory.topic.page",{id:topic.id})).resolves.toMatchObject({total:1,items:[expect.objectContaining({id:durable,presentation:expect.objectContaining({text:"Use local storage for project memory."})})]});
    await call("memory.topic.membership",{topicId:topic.id,memoryId:durable,mode:"exclude"});
    await expect(call("memory.handbook")).resolves.toMatchObject({unassigned:{total:1}});
    await call("memory.topic.membership",{topicId:topic.id,memoryId:durable,mode:"default"});
    await expect(call("memory.export",{dryRun:true})).resolves.toMatchObject({memories:1,dryRun:true});
    await call("memory.export");expect(existsSync(join(root,".code-butler/handbook/index.md"))).toBe(true);
    const selection={kind:"selected",items:[{memoryId:durable,category:"promoted"},{memoryId:candidate,category:"candidate"}]};
    const preview=await call<{selectionFingerprint:string}>("memory.ai.preview",{mode:"wording",selection});
    expect(activeForegroundIntent(root)).toBeUndefined();
    const progress:number[]=[];
    const provider:MemoryReconciliationProvider={provider:"openai-compatible",model:"fixture-wording",async request(input){expect(Object.keys(input.payload).sort()).toEqual(["fields","text"]);return {content:JSON.stringify({...input.payload,text:String(input.payload.text).replace("Use ","Choose ").replace("Keep ","Retain ")}),inputTokens:12,outputTokens:12};}};
    const run=await runDesktopMemoryReview({version:1,action:"memory.ai.run",root,mode:"wording",selection,expectedSelectionFingerprint:preview.selectionFingerprint,tokenCap:10000},p=>progress.push(p.reviewed),()=>false,{provider}) as WordingRun;
    expect(progress).toContain(2);expect(run.counts.planned).toBe(2);
    await expect(call("memory.ai.results",{mode:"wording",runId:run.id})).resolves.toMatchObject({run:{mode:"wording",items:expect.any(Array)}});
    await expect(call("memory.ai.apply",{mode:"wording",runId:run.id,itemIds:[run.items[0]!.itemId]})).resolves.toMatchObject({counts:{applied:1,planned:1}});
    await expect(call("memory.detail",{id:durable})).resolves.toMatchObject({statement:{origin:"ai_wording_accepted"},presentation:{verified:false}});
    await expect(call("memory.ai.revert",{mode:"wording",runId:run.id})).resolves.toMatchObject({counts:{reverted:1,planned:1}});
    await expect(call("memory.detail",{id:durable})).resolves.toMatchObject({summary:"Use local storage for project memory.",presentation:{verified:false}});
    expect(activeForegroundIntent(root)).toBeUndefined();
  } finally {vi.unstubAllEnvs();cleanupTempDir(directory);}
},120000);
