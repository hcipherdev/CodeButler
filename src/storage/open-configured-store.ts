import { loadProjectConfig } from "../config.js";
import { createRedactionPolicy } from "../privacy/policy.js";
import { openMemoryStore, type MemoryStore } from "./store.js";

export function openConfiguredMemoryStore(rootDir: string): MemoryStore {
  const config = loadProjectConfig(rootDir);
  const backupRetention = config.retention?.migrationBackups;
  return openMemoryStore(rootDir, {
    privacyPolicy: createRedactionPolicy(config.privacy),
    ...(backupRetention === undefined ? {} : { backupRetention })
  });
}
