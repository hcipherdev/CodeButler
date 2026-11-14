import { autoConnectAiClients, checkedAiClientStatus, connectAiClient } from "../../desktop/ai-clients.js";

const USAGE = "Usage: code-butler clients status [--json] | clients connect <claude|codex> | clients connect --auto [--json]";

/** Claude Code and Codex connections are global, so this works from any folder. */
export async function runClientsCommand(args: string[], stdout: (line: string) => void): Promise<number> {
  const [subcommand, ...rest] = args;
  const json = rest.includes("--json");
  if (subcommand === "status") {
    if (rest.some(arg => arg !== "--json")) throw new Error(USAGE);
    const status = await checkedAiClientStatus();
    if (json) { stdout(JSON.stringify(status, null, 2)); return 0; }
    if (!status.launcherInstalled) stdout("The code-butler command is not installed for AI clients yet.");
    for (const client of status.clients) stdout(`${client.label}: ${client.state} — ${client.detail}`);
    if (status.serverCheck?.ok) stdout(`MCP server check: started and listed ${status.serverCheck.tools} tools in ${status.serverCheck.durationMs} ms.`);
    else if (status.serverCheck) {
      stdout(`MCP server check failed (${status.serverCheck.reason}): ${status.serverCheck.detail}`);
      stdout(status.serverCheck.fix);
      if (status.serverCheck.stderr) stdout(status.serverCheck.stderr);
    }
    return status.clients.some(client => client.state === "failing") ? 1 : 0;
  }
  if (subcommand === "connect" && rest.includes("--auto")) {
    if (rest.some(arg => arg !== "--auto" && arg !== "--json")) throw new Error(USAGE);
    const outcomes = autoConnectAiClients();
    if (json) stdout(JSON.stringify(outcomes, null, 2));
    else for (const item of outcomes) stdout(`${item.label}: ${item.outcome} — ${item.detail}`);
    return outcomes.some(item => item.outcome === "failed") ? 1 : 0;
  }
  if (subcommand === "connect" && rest.length === 1 && (rest[0] === "claude" || rest[0] === "codex")) {
    const connection = connectAiClient(rest[0]);
    stdout(`${connection.label}: ${connection.state} — Restart ${connection.label} to load Code Butler.`);
    return 0;
  }
  throw new Error(USAGE);
}
