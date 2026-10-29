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

// Summary outputs stay ingestible evidence because people may edit them, but a commit that
// only rewrites them restates existing memory and matches almost any search.
const SEARCH_EXCLUDED_FILES = [".code-butler/project-summary.md", ".code-butler/project-summary.meta.json"];
const SEARCH_EXCLUDED_PREFIXES = [".code-butler/handbook/"];

/** A commit whose every changed file satisfies this is kept out of raw search. */
export function isSearchExcludedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  return SEARCH_EXCLUDED_FILES.includes(normalized) || SEARCH_EXCLUDED_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/** SQL twin of isSearchExcludedPath for a text column holding one path. */
export function searchExcludedPathSql(column: string): string {
  const slashed = `replace(${column},'\\','/')`;
  const normalized = `lower(case when substr(${slashed},1,2)='./' then substr(${slashed},3) else ${slashed} end)`;
  return `(${[
    ...SEARCH_EXCLUDED_FILES.map(file => `${normalized}='${file}'`),
    ...SEARCH_EXCLUDED_PREFIXES.map(prefix => `substr(${normalized},1,${prefix.length})='${prefix}'`)
  ].join(" or ")})`;
}
