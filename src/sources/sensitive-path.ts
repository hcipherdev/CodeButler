/** Paths excluded before Git evidence is read or sent to memory extraction. */
export function isSensitiveGitPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const components = normalized.toLowerCase().split("/");
  if (components[0] === "secrets") return true;
  const name = components.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.") || name === ".envrc") return true;
  if (["credentials.json", "service-account.json", "secrets.json", ".git-credentials", ".netrc"].includes(name)) return true;
  return /\.(?:pem|key|p12|pfx)$/i.test(name);
}

/** Generated handbook documents must not become evidence for their own memories. */
export function isGeneratedMemoryPath(path:string):boolean {
  return path.replaceAll("\\","/").replace(/^\.\//,"").toLowerCase().startsWith(".code-butler/handbook/");
}
