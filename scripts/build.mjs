import { chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync("dist", { recursive: true, force: true });

const tsc = spawnSync(process.platform === "win32" ? "tsc.cmd" : "tsc", ["-p", "tsconfig.build.json"], {
  stdio: "inherit"
});

if (tsc.error) {
  throw tsc.error;
}

if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

if (process.platform !== "win32") {
  chmodSync("dist/cli.js", 0o755);
}
