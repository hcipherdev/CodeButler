import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

export type EncryptionState = "storage-full" | "request-too-large" | "upgrade-required" | "lease-expired" | "authentication-required" | "locked" | "enrollment-required" | "revoked" | "recovery-required" | "conflict" | "incompatible-format" | "verification-failed";
export class EncryptionError extends Error {
  constructor(readonly state: EncryptionState, readonly details?: unknown) {
    const guidance:Record<EncryptionState,string>={
      "storage-full":"Cloud storage full. Inspect cloud storage usage or wait for cleanup.","request-too-large":"The transfer exceeds the server request limit.","upgrade-required":"Upgrade Butler to use this project.","lease-expired":"Transfer lease expired; retry sync.",
      "authentication-required":"Run code-butler cloud login.","enrollment-required":"Run code-butler cloud init or cloud device request.",
      locked:"Unlock secure storage and check that the native helper is installed.",revoked:"Enroll again from an approved device, or use cloud recovery restore.",
      "recovery-required":"Verify your recovery kit before continuing.",conflict:"Retry, or inspect cloud status and resolve the conflicting changes.",
      "incompatible-format":"Upgrade Butler and enable a fresh encrypted project.","verification-failed":"Sync stopped before application; local memories remain available."
    };
    const usage=details as {usageBytes?:number;limitBytes?:number}|undefined;
    const capacity=state==="storage-full" && Number.isFinite(usage?.usageBytes) && Number.isFinite(usage?.limitBytes)
      ? ` Vault usage ${(usage!.usageBytes!/1048576).toFixed(1)} / ${(usage!.limitBytes!/1048576).toFixed(1)} MiB.` : "";
    super(`Encrypted sync: ${state}. ${guidance[state]}${capacity}`);
  }
}
const MAX_IPC = 32 * 1024 * 1024;
const responseSchema = z.object({
  version: z.literal(1), items: z.array(z.string()).optional(),
  signature: z.string().optional(), publicKey: z.string().optional(), verified: z.literal(true).optional(), result: z.unknown().optional()
}).strict();

/** Bounded native IPC. Production operations accept opaque IDs through NativeSecurity. */
export class CryptoHelper {
  constructor(readonly executable: string) {
    if (!isAbsolute(executable)) throw new EncryptionError("locked");
  }
  protected async call(input: object): Promise<z.infer<typeof responseSchema>> {
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...input }));
    if (bytes.length > MAX_IPC) throw new EncryptionError("verification-failed");
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let size = 0; let settled = false;
      const fail = (state: EncryptionState) => {
        if (settled) return; settled = true; clearTimeout(timer); bytes.fill(0);
        child.kill(); reject(new EncryptionError(state));
      };
      const timer = setTimeout(() => fail("locked"), 30000);
      child.on("error", () => fail("locked"));
      child.stdin.on("error", () => fail("locked"));
      // Ignore stderr rather than reflecting dependency diagnostics or sensitive input.
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IPC) fail("verification-failed"); else chunks.push(chunk);
      });
      child.on("close", code => {
        if (settled) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          if (code !== 0 || value.error) {
            const allowed = ["authentication-required", "locked", "enrollment-required", "revoked", "recovery-required", "conflict", "incompatible-format", "verification-failed"];
            fail(allowed.includes(String(value.error)) ? value.error as EncryptionState : "verification-failed"); return;
          }
          const parsed = responseSchema.parse(value);
          settled = true; clearTimeout(timer); bytes.fill(0); resolve(parsed);
        } catch { fail("verification-failed"); }
        finally { for (const chunk of chunks) chunk.fill(0); }
      });
      child.stdin.end(bytes);
    });
  }
}
