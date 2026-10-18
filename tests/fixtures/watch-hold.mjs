import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), ".code-butler");
mkdirSync(directory, { recursive: true });
const path = join(directory, ".cloud-operation.lock");
writeFileSync(path, JSON.stringify({ pid: Number(process.env.WATCH_FIXTURE_LOCK_PID) || process.pid, token: "watch-hold", watcherToken: process.env.CODE_BUTLER_WATCH_TOKEN, name: "Watcher database step", startedAt: new Date().toISOString() }));
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { unlinkSync(path); } catch { /* Parent may have removed a test lock. */ }
  process.send?.({ type: "watch-result", outcome: "deferred", stage: "ingestion", reason: "Watcher stopped" });
  setTimeout(() => process.exit(75), 10);
};
process.on("message", message => { if (message?.type === "watch-stop") stop(); });
process.once("SIGTERM", stop);
setInterval(() => {}, 1000);
