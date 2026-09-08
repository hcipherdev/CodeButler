import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { stdin, stdout as terminal } from "node:process";
import { z } from "zod";
import { openConfiguredMemoryStore } from "../storage/open-configured-store.js";
import { captureSnapshot } from "./snapshot.js";
import { cloudSync, projectOperation, request } from "./client.js";
import { atomicJson, binding, connection, connectionPath, saveBinding, serverUrl, UUID, type Connection } from "./state.js";

async function readSecret(): Promise<string> {
  if (!stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) { value += chunk.toString(); if (value.length > 256) throw new Error("Invalid beta code"); }
    return value.trim();
  }
  terminal.write("Beta code (hidden): "); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.off("data", read); terminal.write("\n"); };
    const read = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") { finish(); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); resolve(value.trim()); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (value.length < 128) value += char;
      }
    };
    stdin.on("data", read);
  });
}
export async function runCloudCommand(args: string[], root: string, output: (line: string) => void, secretReader = readSecret): Promise<number> {
  const [command, ...rest] = args;
  const allowed: Record<string, string[]> = { connect: ["--server"], projects: [], enable: ["--project", "--name"], status: [], sync: [], disable: [], resolve: ["--keep"] };
  if (!command || !allowed[command]) throw new Error("Usage: code-butler cloud <connect|projects|enable|status|sync|disable|resolve>");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!; const value = rest[i + 1];
    if (!allowed[command]!.includes(key) || !value || flags.has(key)) throw new Error("Invalid cloud command options");
    flags.set(key, value);
  }
  if (command === "connect") {
    const server = serverUrl(flags.get("--server") ?? "");
    output("Cloud snapshots are readable by the server operator. Your beta code grants access to this vault on every device; keep it private.");
    const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(await secretReader());
    const conn: Connection = { server, secret, vaultId: "" };
    const status = await (await request(conn, "/v1/vault")).json() as { vaultId: string; expiresAt: number };
    UUID.parse(status.vaultId); conn.vaultId = status.vaultId;
    atomicJson(connectionPath(), conn); output(`Connected. Beta expires ${new Date(status.expiresAt).toISOString()}`); return 0;
  }
  if (command === "projects") { output(JSON.stringify(await (await request(connection(), "/v1/projects")).json(), null, 2)); return 0; }
  if (command === "status") { output(JSON.stringify(binding(root) ?? { enabled: false }, (_key, value) => value, 2)); return 0; }
  if (command === "disable") {
    await projectOperation(root, () => {
      const current = binding(root);
      if (current) { current.enabled = false; current.status = "disabled"; saveBinding(root, current); }
    });
    output("Cloud sync disabled; local memory retained."); return 0;
  }
  if (command === "enable") {
    if (binding(root)?.enabled) throw new Error("Cloud already enabled; disable it before changing the project binding");
    const conn = connection();
    const id = flags.has("--project") ? UUID.parse(flags.get("--project")) : (await (await request(conn, "/v1/projects", "POST", { name: flags.get("--name") ?? basename(root) })).json() as { id: string }).id;
    await request(conn, `/v1/projects/${id}/head`);
    await projectOperation(root, async () => {
      const current = binding(root);
      const checkoutId = current?.checkoutId && UUID.safeParse(current.checkoutId).success ? current.checkoutId : randomUUID();
      const store = openConfiguredMemoryStore(root); let occupied: boolean;
      try { store.init(); occupied = Number((store.db.prepare("select count(*) as n from sources").get() as { n: number }).n) > 0; } finally { store.close(); }
      const local = await captureSnapshot(root, id, 0, checkoutId);
      saveBinding(root, { projectId: id, server: conn.server, vaultId: conn.vaultId, enabled: true, revision: 0, fingerprint: flags.has("--project") && !occupied ? local.snapshot.fingerprint : "", status: "ready", checkoutId });
    });
    output("Enabled cloud sync. Restart MCP sessions opened before enabling to allow automatic restores.");
    try {
      const result = await cloudSync(root);
      output(`Initial cloud sync status: ${result?.status ?? "unknown"}${result?.revision != null ? ` (revision ${result.revision})` : ""}.`);
    } catch (error) {
      output(`Initial cloud sync deferred: ${error instanceof Error ? error.message : "Cloud sync deferred"}`);
    }
    return 0;
  }
  const keep = command === "resolve" ? z.enum(["local", "cloud"]).parse(flags.get("--keep")) : undefined;
  if (!binding(root)?.enabled) throw new Error("Cloud sync is not enabled for this checkout");
  const result = await cloudSync(root, keep); output(JSON.stringify(result, null, 2)); return 0;
}
