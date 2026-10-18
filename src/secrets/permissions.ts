import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { SecretFolderError } from "./folder-error.js";

/** Downloads inherit a private directory ACL on Windows and mode 0700 on macOS. */
export function restrictSecretDirectory(path: string): void { restrict(path, true); }
export function restrictSecretFile(path: string): void { restrict(path, false); }
function restrict(path: string, directory: boolean): void {
  if (process.platform !== "win32") {
    try { chmodSync(path, directory ? 0o700 : 0o600); }
    catch { throw new SecretFolderError(`Butler could not limit access to ${path} to your account. Make sure your account owns it, then sync again.`); }
    return;
  }
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const options = { windowsHide: true, timeout: 30000, stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] };
  const identity = execFileSync(join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true, timeout: 30000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const sid = /S-\d+(?:-\d+)+/.exec(identity)?.[0];
  if (!sid) throw new Error("Could not determine the current Windows user identity.");
  const icacls = join(system, "icacls.exe"), grant = directory ? "(OI)(CI)F" : "F";
  // Reset explicit entries, grant this user and SYSTEM, and only then drop inherited entries: a refusal at any
  // step leaves the inherited access in place instead of an entry list nobody can use.
  try {
    execFileSync(icacls, [path, "/reset"], options);
    execFileSync(icacls, [path, "/grant:r", `*${sid}:${grant}`, `*S-1-5-18:${grant}`], options);
    execFileSync(icacls, [path, "/inheritance:r"], options);
  } catch {
    // Usually another account owns the folder, such as a sandbox user that created it.
    throw new SecretFolderError(`Butler could not limit access to ${path} to your account; another Windows account probably owns it. ` +
      `Make yourself the owner (in an administrator PowerShell: takeown /f "${path}"), then sync again.`);
  }
}
