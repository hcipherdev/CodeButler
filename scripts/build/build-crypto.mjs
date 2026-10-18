import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync("cargo", ["build", "--locked", "--manifest-path", "native/butler-crypto/Cargo.toml"], {
  cwd, stdio: "inherit", windowsHide: true,
  env: { ...process.env, ...(process.platform === "win32" ? { AWS_LC_SYS_PREBUILT_NASM: "1" } : {}) }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
