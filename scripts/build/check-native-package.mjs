import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root=fileURLToPath(new URL("../..",import.meta.url));
const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
for(const platform of["win32-x64","darwin-x64","darwin-arm64"]){
  const directory=join(root,"dist","native",platform),manifest=JSON.parse(readFileSync(join(directory,"manifest.json"),"utf8"));
  const binary=platform.startsWith("win32")?"butler-crypto.exe":"butler-crypto";
  if(manifest.binary!==binary||manifest.sha256!==digest(join(directory,binary))||manifest.cargoLockSha256!==digest(join(root,"native","butler-crypto","Cargo.lock")))throw new Error(`Native artifact integrity check failed: ${platform}`);
}
console.log("All Windows/macOS native package artifacts verified.");
