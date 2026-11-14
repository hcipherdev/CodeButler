import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertStaticWindowsRuntime } from "./windows-pe-imports.mjs";

const root=fileURLToPath(new URL("../..",import.meta.url));
if(!["win32","darwin"].includes(process.platform)) throw new Error("Native enrollment is packaged for Windows and macOS only");
const windows = process.platform === "win32";
const target = "x86_64-pc-windows-msvc";
const targetDir = join(root, "native", "butler-crypto", "target");
const args = ["build", "--release", "--locked", "--manifest-path", "native/butler-crypto/Cargo.toml"];
const env = { ...process.env };
if (windows) {
  if (process.arch !== "x64") throw new Error("Use x64 Node.js to package the Windows x64 crypto helper.");
  args.push("--target", target, "--target-dir", targetDir);
  env.AWS_LC_SYS_PREBUILT_NASM = "1";
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, "-C", "target-feature=+crt-static"].filter(Boolean).join("\x1f");
  } else {
    env.RUSTFLAGS = [env.RUSTFLAGS, "-C target-feature=+crt-static"].filter(Boolean).join(" ");
  }
}
const result=spawnSync("cargo",args,{cwd:root,stdio:"inherit",windowsHide:true,env});
if(result.error) throw result.error; if(result.status!==0) process.exit(result.status??1);
const name=windows?"butler-crypto.exe":"butler-crypto";
const source = join(windows ? join(targetDir, target) : targetDir, "release", name);
if (windows) assertStaticWindowsRuntime(source);
const directory=join(root,"dist","native",`${process.platform}-${process.arch}`);mkdirSync(directory,{recursive:true});
copyFileSync(source,join(directory,name));
copyFileSync(join(root,"native","vendor","hybridcipher-crypto","LICENSE-APACHE"),join(directory,"LICENSE-HybridCipher"));
copyFileSync(join(root,"native","vendor","hybridcipher-crypto","PROVENANCE.md"),join(directory,"PROVENANCE.md"));
copyFileSync(join(root,"native","butler-crypto","Cargo.lock"),join(directory,"Cargo.lock"));
const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(directory,"manifest.json"),JSON.stringify({version:1,platform:process.platform,arch:process.arch,binary:name,sha256:digest(source),cargoLockSha256:digest(join(directory,"Cargo.lock")),hybridCipherRevision:"38810069a84f5050b7d1e9798510c89311156ef6"},null,2));
