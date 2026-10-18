import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** GUI clients and scheduled tasks can inherit a PATH from before Git was installed. */
export function gitExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string {
  if (env.CODE_BUTLER_GIT?.trim()) return env.CODE_BUTLER_GIT.trim();
  if (platform !== "win32") return "git";
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of path.split(platform === "win32" ? ";" : delimiter)) {
    if (!directory.trim()) continue;
    const candidate = join(directory.replace(/^"|"$/g, ""), "git.exe");
    if (exists(candidate)) return candidate;
  }
  for (const directory of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"]) {
    if (!directory) continue;
    const candidate = join(directory, "Git", "cmd", "git.exe");
    if (exists(candidate)) return candidate;
  }
  if (env.LOCALAPPDATA) {
    const candidate = join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe");
    if (exists(candidate)) return candidate;
  }
  return "git";
}
