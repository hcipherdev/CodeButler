import { ensureGlobalConfig, loadProjectConfig } from "./config.js";
import { clearProjectRemoved } from "./cloud/removal-state.js";
import { recordProjectSetupCompletion, validateProjectSetupPaths } from "./project-setup.js";
import {
  initializeProjectSummary,
  type ProjectSummaryOperationOptions
} from "./project-summary/service.js";
import { openConfiguredMemoryStore } from "./storage/open-configured-store.js";

export interface ProjectInitializationResult {
  summaryPath: string;
  fallback: boolean;
  backupFiles: string[];
  warnings: string[];
}

/** The project-local portion of CLI init, shared with the desktop app. */
export async function initializeProjectMemory(
  root: string,
  options: ProjectSummaryOperationOptions = {}
): Promise<ProjectInitializationResult> {
  clearProjectRemoved(root);
  validateProjectSetupPaths(root);
  ensureGlobalConfig();
  const warnings: string[] = [];
  const store = openConfiguredMemoryStore(root);
  try {
    store.init();
    const config = loadProjectConfig(root);
    const installed = await initializeProjectSummary(store, config, {
      ...options,
      warn(message) {
        warnings.push(message);
        options.warn?.(message);
      }
    });
    recordProjectSetupCompletion(root, installed.backupFiles ?? [], (options.now ?? (() => new Date()))());
    return {
      summaryPath: installed.summaryPath,
      fallback: installed.fallback,
      backupFiles: installed.backupFiles ?? [],
      warnings
    };
  } finally {
    store.close();
  }
}
