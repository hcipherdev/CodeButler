import { pendingProjectSettings, trustProjectSettings } from "../../config.js";

const USAGE = "Usage: code-butler config trust <status|approve>";

/**
 * `config trust`: shows the repository's own settings that wait for approval on this device, and
 * approves them. A later change to any of them needs approving again. The desktop app offers the
 * same review on the project overview.
 */
export function runTrustCommand(args: string[], cwd: string, stdout: (line: string) => void): number {
  const [choice, ...extra] = args;
  if (extra.length > 0 || (choice !== "status" && choice !== "approve")) throw new Error(USAGE);
  if (choice === "approve") {
    const trust = trustProjectSettings(cwd);
    stdout(trust.status === "none-needed"
      ? "Nothing in .code-butler/ needs approval."
      : `Approved on this device: ${trust.paths.join(", ")}`);
    return 0;
  }
  for (const line of describePendingSettings(cwd)) stdout(line);
  return 0;
}

/** The status line and each pending setting, for `config trust status` and `init`. */
export function describePendingSettings(cwd: string): string[] {
  const pending = pendingProjectSettings(cwd);
  const lines = [`trust=${pending.status}`];
  if (pending.status === "none-needed") return lines;
  for (const setting of pending.settings) lines.push(`  ${setting.path} = ${setting.value}`);
  if (pending.envNames.length) lines.push(`  .env: ${pending.envNames.join(", ")} (values not shown)`);
  if (pending.status === "untrusted") lines.push("Ignored until approved. Review them in the desktop app's project overview, or run: code-butler config trust approve");
  return lines;
}
