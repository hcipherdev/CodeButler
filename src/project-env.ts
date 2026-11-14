/**
 * Keys from a project's own `.code-butler/.env`. They are kept per project rather than written to
 * process.env, because one long-running server serves many projects and must not carry one
 * project's values into another.
 */
const projectValues = new Map<string, ReadonlyMap<string, string>>();

/** Names a project .env may never set, even once the project is trusted: they change how programs run. */
const RESERVED_ENV_NAME = /^(?:CODE_BUTLER_|GIT_|NODE_|NPM_|LD_|DYLD_|SSH_|SSL_|ELECTRON_|BASH_|ZDOTDIR$|PATH$|PATHEXT$|HOME$|USERPROFILE$|SHELL$|COMSPEC$|TMPDIR$|TEMP$|TMP$|ENV$|PYTHON|PERL|RUBY|JAVA_TOOL_OPTIONS$|.*_PROXY$|.*_CA_BUNDLE$|.*_CA_CERTS?$)/i;

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_NAME.test(name);
}

/** Variables process.env holds only because the global .env filled them; a project's own value outranks those. */
const filledFromGlobalEnv = new Set<string>();

export function setProjectEnv(root: string, values: ReadonlyMap<string, string>): void {
  if (values.size) projectValues.set(root, values);
  else projectValues.delete(root);
}

export function markFilledFromGlobalEnv(name: string): void {
  filledFromGlobalEnv.add(name);
}

/** The shell environment wins, then the project's .env, then the global .env. */
export function readEnv(name: string | undefined, envRoot?: string): string | undefined {
  if (!name) return undefined;
  return lookup(name, envRoot)?.trim() || undefined;
}

/** A read-only process.env view with one project's values applied, for code that takes an env object. */
export function projectEnvView(envRoot?: string): NodeJS.ProcessEnv {
  const values = envRoot ? projectValues.get(envRoot) : undefined;
  if (!values?.size) return process.env;
  const view: NodeJS.ProcessEnv = { ...process.env };
  for (const name of values.keys()) view[name] = lookup(name, envRoot);
  return view;
}

function lookup(name: string, envRoot: string | undefined): string | undefined {
  const fromProcess = process.env[name];
  const fromShell = fromProcess !== undefined && fromProcess !== "" && !filledFromGlobalEnv.has(name);
  if (fromShell || !envRoot) return fromProcess;
  return projectValues.get(envRoot)?.get(name) ?? fromProcess;
}
