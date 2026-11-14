import { parse, stringify } from "smol-toml";
import { backupClientConfig, writeClientConfig } from "./client-config-write.js";

export interface CodexConfig { mcp_servers?: Record<string, unknown> }

/** Never include parser errors: they can quote credentials from the config. */
export function parseCodexConfig(text: string | undefined): CodexConfig {
  try {
    const config = parse((text ?? "").replace(/^\uFEFF/, ""));
    const servers = config.mcp_servers;
    if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error();
    return config as CodexConfig;
  } catch { throw new Error("Codex config.toml is invalid or has an unsupported mcp_servers layout. Correct it in Codex settings, then try Connect again. No settings were changed."); }
}

export function missingCodexConfig(text: string | undefined, launcher: { command: string; args: string[] }): string {
  const config = parseCodexConfig(text);
  if (config.mcp_servers && Object.hasOwn(config.mcp_servers, "code-butler")) throw new Error("A code-butler entry already exists. Use the Codex CLI or Codex settings to review it; direct setup only adds missing entries.");
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  const addition = stringify({ mcp_servers: { "code-butler": launcher } }).replace(/\n/g, eol);
  const next = `${text ?? ""}${text ? eol + eol : ""}${addition}`;
  try { parseCodexConfig(next); }
  catch { throw new Error("Codex config.toml uses a layout that cannot be extended safely. Use the Codex CLI or Codex settings to add Code Butler. No settings were changed."); }
  return next;
}

export function writeCodexConfig(path: string, previous: string | undefined, next: string, backup = backupClientConfig): void {
  writeClientConfig(path, previous, next, backup);
}
