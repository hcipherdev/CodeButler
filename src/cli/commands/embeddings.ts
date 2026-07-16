import { loadProjectConfig } from "../../config.js";
import {
  buildEmbeddings,
  getEmbeddingStatus,
  type EmbeddingBuildResult,
  type EmbeddingServiceOptions,
  type EmbeddingStatus
} from "../../embeddings/service.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";

export async function runEmbeddingsCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void,
  serviceOptions: EmbeddingServiceOptions = {}
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "build" && subcommand !== "status") {
    throw new Error("Usage: code-butler embeddings <build|status> [--json]");
  }
  const json = rest.includes("--json");
  const unknown = rest.find((arg) => arg !== "--json");
  if (unknown) {
    throw new Error(`Unknown embeddings option: ${unknown}\nUsage: code-butler embeddings ${subcommand} [--json]`);
  }
  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    const config = loadProjectConfig(cwd);
    const result = subcommand === "build"
      ? await buildEmbeddings(store, config, serviceOptions)
      : getEmbeddingStatus(store, config, serviceOptions);
    if (json) {
      stdout(JSON.stringify({
        provider: config.embeddings.provider,
        model: config.embeddings.model,
        ...result
      }, null, 2));
    } else {
      printEmbeddingStatus(
        subcommand,
        config.embeddings.provider,
        config.embeddings.model,
        result,
        stdout
      );
    }
    return subcommand === "build" && "usable" in result && !result.usable ? 1 : 0;
  } finally {
    store.close();
  }
}

function printEmbeddingStatus(
  operation: "build" | "status",
  provider: string,
  model: string,
  result: EmbeddingStatus | EmbeddingBuildResult,
  stdout: (line: string) => void
): void {
  stdout(operation === "build" ? "Embedding Build" : "Embedding Status");
  stdout(`provider=${provider} model=${model} enabled=${result.enabled}`);
  stdout(`eligible=${result.eligible} coverage=${result.activeCoverage}/${result.eligible} pending=${result.pending} complete=${result.complete} failed=${result.failed} attempts=${result.attempts}`);
  if ("built" in result) {
    stdout(`built=${result.built} retried=${result.retried} enqueued=${result.enqueued} removed_jobs=${result.removedJobs} removed_vectors=${result.removedVectors}`);
  }
  for (const warning of result.warnings) stdout(`warning=${warning}`);
}
