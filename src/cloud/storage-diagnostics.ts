import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { projectOperation } from "./client.js";
import { AccountClient } from "./account-client.js";
import { binding, saveBinding, stateDirectory } from "./state.js";
import { withProjectGate } from "./gate.js";
import type { StorageUsageReport } from "./protocol-types.js";

export type StorageReport = StorageUsageReport & {checkedAt:string};
export async function cloudStorageReport(root:string):Promise<StorageReport> {
  const state=binding(root);if(!state?.enabled)throw new Error("Cloud sync is not enabled");
  const report={...await new AccountClient(state.server).request<StorageUsageReport>(`/v2/projects/${state.projectId}/storage`),checkedAt:new Date().toISOString()};
  // Merge with the latest binding; a background sync may have advanced it.
  await withProjectGate(stateDirectory(root),()=>{
    const current=binding(root);if(current?.projectId===state.projectId)saveBinding(root,{...current,storage:report});
  });
  return report;
}
/** Diagnostics never query or mutate the live store beyond SQLite's consistent backup API. */
export async function localStorageReport(root:string) {
  const directory=mkdtempSync(join(tmpdir(),"butler-size-")),path=join(directory,"snapshot.sqlite");
  try {
    await projectOperation(root,async()=>{const source=new DatabaseSync(join(root,".code-butler","memory.sqlite"),{readOnly:true});try{await backup(source,path);}finally{source.close();}});
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      const scalar=(sql:string)=>Number(Object.values(db.prepare(sql).get()!)[0]);
      const pageSize=scalar("pragma page_size"),unusedBytes=scalar("pragma freelist_count")*pageSize;
      let tables:Array<{name:string;bytes:number}>=[],tableSizeAvailable=true;
      try{tables=db.prepare("select name,sum(pgsize) bytes from dbstat group by name order by bytes desc").all() as typeof tables;}catch{tableSizeAvailable=false;}
      const sourceTextBytes=scalar("select coalesce(sum(length(cast(raw_content as blob))),0) from sources");
      const memories=scalar("select count(*) from memories");
      const searchIndexBytes=tables.filter(t=>/fts|embedding/.test(t.name)).reduce((n,t)=>n+t.bytes,0);
      return {snapshotBytes:statSync(path).size,pageSize,unusedBytes,sourceTextBytes,memories,tableSizeAvailable,tables,searchIndexBytes,potentialCompactionSavingsBytes:unusedBytes,note:"Size estimates only. No memory content, evidence, or indexes were removed. Search data requires a tested rebuild strategy before exclusion."};
    }finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
}
