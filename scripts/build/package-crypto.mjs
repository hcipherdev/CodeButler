import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../..",import.meta.url));
if(!["win32","darwin"].includes(process.platform)) throw new Error("Native enrollment is packaged for Windows and macOS only");
const result=spawnSync("cargo",["build","--release","--locked","--manifest-path","native/butler-crypto/Cargo.toml"],{cwd:root,stdio:"inherit",windowsHide:true,env:{...process.env,...(process.platform==="win32"?{AWS_LC_SYS_PREBUILT_NASM:"1"}:{})}});
if(result.error) throw result.error; if(result.status!==0) process.exit(result.status??1);
const name=process.platform==="win32"?"butler-crypto.exe":"butler-crypto";
const directory=join(root,"dist","native",`${process.platform}-${process.arch}`);mkdirSync(directory,{recursive:true});
const source=join(root,"native","butler-crypto","target","release",name);copyFileSync(source,join(directory,name));
copyFileSync(join(root,"native","vendor","hybridcipher-crypto","LICENSE-APACHE"),join(directory,"LICENSE-HybridCipher"));
copyFileSync(join(root,"native","vendor","hybridcipher-crypto","PROVENANCE.md"),join(directory,"PROVENANCE.md"));
copyFileSync(join(root,"native","butler-crypto","Cargo.lock"),join(directory,"Cargo.lock"));
const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(directory,"manifest.json"),JSON.stringify({version:1,platform:process.platform,arch:process.arch,binary:name,sha256:digest(source),cargoLockSha256:digest(join(directory,"Cargo.lock")),hybridCipherRevision:"38810069a84f5050b7d1e9798510c89311156ef6"},null,2));
