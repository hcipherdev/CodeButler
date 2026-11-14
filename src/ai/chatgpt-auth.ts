import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { atomicWrite } from "../cloud/state.js";
import { globalConfigDir, loadGlobalAiSettings, saveGlobalAiSettings } from "../config.js";
import { keychainStore } from "./credentials.js";
import { AiConnectionError } from "./errors.js";

/*
 * Sign in with ChatGPT, plan-usage flow for open-source local apps (developers.openai.com/siwc).
 * OAuth with PKCE against a client ID that OpenAI issues to this app per account on first sign-in.
 * Tokens stay on this machine: encrypted with a key held in the OS keychain, or, where there is no
 * keychain (Linux), in an owner-only file as OpenAI's guidance describes.
 */

const AUTH_ORIGIN = "https://auth.openai.com";
export const CHATGPT_AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const REVOKE_URL = `${AUTH_ORIGIN}/api/accounts/oauth/revoke`;
const JWKS_URL = `${AUTH_ORIGIN}/.well-known/jwks.json`;
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
/** The first registration's callback port; later sign-ins may use any free port with the same path. */
export const CHATGPT_FIRST_PORT = 1455;
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
const REGISTRATION_CLIENT = "dynamic_agent_client";
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOCK_STALE_MS = 30_000;

export const CHATGPT_SIGNED_OUT = "ChatGPT is not signed in. Open Code Butler's AI models settings, or run `code-butler ai chatgpt login`, and sign in again.";
export const CHATGPT_PLAN_REQUIRED = "OpenAI did not allow plan usage for this account. Using your ChatGPT plan in other apps needs ChatGPT Plus or Pro, and approving \"ChatGPT plan\" on the consent screen.";

export interface ChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string | undefined;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  earliestRefreshAt?: number | undefined;
  scope: string;
  account: string;
  email?: string | undefined;
}
interface StoredRecord {
  version: 1;
  /** Not secret, and kept after sign-out: later sign-ins reuse the ID OpenAI issued. */
  clientId?: string | undefined;
  sealed?: { iv: string; tag: string; data: string } | undefined;
  /** Only where no keychain exists. */
  plain?: ChatGptTokens | undefined;
}
export interface ChatGptDeps { fetchImpl?: typeof fetch; now?: () => number; directory?: string; platform?: NodeJS.Platform }

const authDirectory = (deps: ChatGptDeps) => deps.directory ?? join(globalConfigDir(), "ai-auth");
const recordPath = (id: string, deps: ChatGptDeps) => join(authDirectory(deps), `${id}.json`);
const nowOf = (deps: ChatGptDeps) => (deps.now ?? Date.now)();
const b64url = (value: Buffer) => value.toString("base64url");

/** Opaque and stable per installation; deliberately not the device ID, which other data already carries. */
export function chatgptHostId(deps: ChatGptDeps = {}): string {
  const path = join(authDirectory(deps), "host-id");
  try {
    const saved = readFileSync(path, "utf8").trim();
    if (/^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
  } catch { /* Created below. */ }
  const created = `urn:uuid:${randomUUID()}`;
  atomicWrite(path, created);
  return created;
}

function readRecord(id: string, deps: ChatGptDeps): StoredRecord {
  try {
    const value = JSON.parse(readFileSync(recordPath(id, deps), "utf8")) as StoredRecord;
    return value && value.version === 1 ? value : { version: 1 };
  } catch { return { version: 1 }; }
}

function writeRecord(id: string, record: StoredRecord, deps: ChatGptDeps): void {
  atomicWrite(recordPath(id, deps), JSON.stringify(record));
}

const usesKeychain = (deps: ChatGptDeps) => (deps.platform ?? process.platform) !== "linux";
const keyCache = new Map<string, Buffer>();

async function sealingKey(id: string, create: boolean): Promise<Buffer> {
  const cached = keyCache.get(id);
  if (cached) return cached;
  let encoded: string | undefined;
  try { encoded = await keychainStore().get(id); } catch { encoded = undefined; }
  if (!encoded && create) {
    encoded = b64url(randomBytes(32));
    try { await keychainStore().set(id, encoded); }
    catch { throw new AiConnectionError("The ChatGPT sign-in could not be saved to the system keychain."); }
  }
  if (!encoded) throw new AiConnectionError(CHATGPT_SIGNED_OUT);
  const key = Buffer.from(encoded, "base64url");
  keyCache.set(id, key);
  return key;
}

async function readTokens(id: string, deps: ChatGptDeps): Promise<ChatGptTokens | undefined> {
  const record = readRecord(id, deps);
  if (record.plain) return record.plain;
  if (!record.sealed) return undefined;
  const open = (key: Buffer) => {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.sealed!.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(record.sealed!.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.sealed!.data, "base64url")), decipher.final()]).toString("utf8")) as ChatGptTokens;
  };
  try { return open(await sealingKey(id, false)); }
  catch {
    // A cached key from an earlier sign-in; read the keychain once more before giving up.
    keyCache.delete(id);
    try { return open(await sealingKey(id, false)); } catch { return undefined; }
  }
}

async function saveTokens(id: string, clientId: string, tokens: ChatGptTokens | undefined, deps: ChatGptDeps): Promise<void> {
  if (!tokens) { writeRecord(id, { version: 1, clientId }, deps); return; }
  if (!usesKeychain(deps)) { writeRecord(id, { version: 1, clientId, plain: tokens }, deps); return; }
  const key = await sealingKey(id, true);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  writeRecord(id, { version: 1, clientId, sealed: { iv: b64url(iv), tag: b64url(cipher.getAuthTag()), data: b64url(data) } }, deps);
}

/** Removes everything a ChatGPT connection stored; used when the connection itself is deleted. */
export function deleteChatGptCredentials(id: string, deps: ChatGptDeps = {}): void {
  keyCache.delete(id);
  rmSync(recordPath(id, deps), { force: true });
}

export interface ChatGptSignInStart { url: string; state: string; nonce: string; verifier: string }

/** Everything the browser step needs; the caller keeps state, nonce and verifier until the callback. */
export async function startChatGptSignIn(id: string, redirectUri: string, deps: ChatGptDeps = {}): Promise<ChatGptSignInStart> {
  const callback = new URL(redirectUri);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== CHATGPT_CALLBACK_PATH) {
    throw new Error("The ChatGPT callback must be http://127.0.0.1:<port>/auth/callback");
  }
  const record = readRecord(id, deps);
  if (!record.clientId && callback.port !== String(CHATGPT_FIRST_PORT)) throw new AiConnectionError(`The first ChatGPT sign-in needs port ${CHATGPT_FIRST_PORT}, which another program is using. Close any other ChatGPT or Codex sign-in that is waiting, then try again.`);
  const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(32)), nonce = b64url(randomBytes(32));
  const idToken = record.clientId ? (await readTokens(id, deps))?.idToken : undefined;
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const params: Record<string, string> = {
    client_id: record.clientId ?? REGISTRATION_CLIENT,
    ...(record.clientId ? {} : { agent_name_hint: "Code Butler" }),
    ext_agent_host_id: chatgptHostId(deps),
    ...(idToken ? { id_token_hint: idToken } : {}),
    response_type: "code", redirect_uri: redirectUri, scope: SCOPE, resource: CHATGPT_RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: b64url(createHash("sha256").update(verifier).digest())
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), state, nonce, verifier };
}

export interface ChatGptCallback {
  code: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Present on a first registration; must match a saved ID otherwise. */
  clientId?: string | undefined;
  /** What the callback said was granted, used to explain a refused exchange. */
  scope?: string | undefined;
}
export interface ChatGptSignInResult { email?: string | undefined; account: string; clientId: string }

async function tokenRequest(body: Record<string, string>, deps: ChatGptDeps): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await (deps.fetchImpl ?? fetch)(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000)
  });
  let json: Record<string, unknown> = {};
  try { json = await response.json() as Record<string, unknown>; } catch { /* Status alone says enough. */ }
  return { status: response.status, json };
}

function tokensFrom(json: Record<string, unknown>, previous: ChatGptTokens | undefined, claims: { sub: string; email?: string | undefined }, deps: ChatGptDeps): ChatGptTokens {
  const access = json.access_token, refresh = json.refresh_token ?? previous?.refreshToken;
  if (typeof access !== "string" || typeof refresh !== "string") throw new AiConnectionError("OpenAI returned an incomplete ChatGPT sign-in.");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const earliest = typeof json.earliest_refresh_at === "number" ? json.earliest_refresh_at * (json.earliest_refresh_at < 1e12 ? 1000 : 1)
    : typeof json.earliest_refresh_at === "string" ? Date.parse(json.earliest_refresh_at) : undefined;
  return {
    accessToken: access, refreshToken: refresh,
    idToken: typeof json.id_token === "string" ? json.id_token : previous?.idToken,
    expiresAt: nowOf(deps) + expiresIn * 1000,
    ...(earliest !== undefined && Number.isFinite(earliest) ? { earliestRefreshAt: earliest } : {}),
    scope: typeof json.scope === "string" ? json.scope : previous?.scope ?? "",
    account: claims.sub, ...(claims.email ? { email: claims.email } : {})
  };
}

/** Exchanges the browser's code, checks the ID token and the plan grant, and saves the tokens. */
export async function completeChatGptSignIn(id: string, callback: ChatGptCallback, deps: ChatGptDeps = {}): Promise<ChatGptSignInResult> {
  const saved = readRecord(id, deps).clientId;
  if (saved && callback.clientId && callback.clientId !== saved) throw new AiConnectionError("OpenAI answered for a different app registration. Sign in again.");
  const clientId = callback.clientId ?? saved;
  if (!clientId) throw new AiConnectionError("OpenAI did not finish registering Code Butler. Sign in again.");
  // Kept before the exchange: a refused code is retried with the issued ID, not a new registration.
  if (!saved) await saveTokens(id, clientId, undefined, deps);
  const exchange = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: callback.code, code_verifier: callback.verifier, redirect_uri: callback.redirectUri, resource: CHATGPT_RESOURCE }, deps);
  if (exchange.status >= 300 || typeof exchange.json.access_token !== "string") {
    if (callback.scope !== undefined && !callback.scope.split(" ").includes(CHATGPT_PLAN_SCOPE)) throw new AiConnectionError(CHATGPT_PLAN_REQUIRED);
    throw new AiConnectionError(exchange.json.error === "invalid_grant"
      ? "OpenAI did not accept this sign-in. Sign in again; if it keeps failing, check that your ChatGPT plan is Plus or Pro."
      : `OpenAI refused the ChatGPT sign-in (status ${exchange.status}).`);
  }
  const claims = await verifyIdToken(exchange.json.id_token, clientId, callback.nonce, deps);
  const tokens = tokensFrom(exchange.json, undefined, claims, deps);
  if (!tokens.scope.split(" ").includes(CHATGPT_PLAN_SCOPE)) throw new AiConnectionError(CHATGPT_PLAN_REQUIRED);
  await saveTokens(id, clientId, tokens, deps);
  markConnection(id, { keyUpdatedAt: new Date(nowOf(deps)).toISOString(), accountLabel: claims.email });
  return { account: claims.sub, clientId, ...(claims.email ? { email: claims.email } : {}) };
}

interface IdClaims { sub: string; email?: string | undefined }

async function verifyIdToken(token: unknown, clientId: string, nonce: string, deps: ChatGptDeps): Promise<IdClaims> {
  const fail = () => new AiConnectionError("OpenAI's sign-in response could not be verified. Sign in again.");
  if (typeof token !== "string") throw fail();
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw fail();
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch { throw fail(); }
  if (header.alg !== "RS256") throw fail();
  const response = await (deps.fetchImpl ?? fetch)(JWKS_URL, { signal: AbortSignal.timeout(20_000) });
  const keys = ((await response.json().catch(() => ({}))) as { keys?: Array<JsonWebKey & { kid?: string }> }).keys ?? [];
  const jwk = keys.find(key => key.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw fail();
  const signed = verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signaturePart, "base64url"));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expires = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  if (!signed || claims.iss !== AUTH_ORIGIN || !audience.includes(clientId) || expires <= nowOf(deps) || claims.nonce !== nonce || typeof claims.sub !== "string") throw fail();
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

/** Writes the non-secret sign-in markers the settings view and credential checks read. */
function markConnection(id: string, marks: { keyUpdatedAt?: string | undefined; accountLabel?: string | undefined }): void {
  const settings = loadGlobalAiSettings();
  const connection = settings?.connections?.[id];
  if (!settings || !connection) return;
  const { keyUpdatedAt: _old, accountLabel: _oldLabel, ...rest } = connection;
  saveGlobalAiSettings({ ...settings, connections: { ...settings.connections, [id]: {
    ...rest, ...(marks.keyUpdatedAt ? { keyUpdatedAt: marks.keyUpdatedAt } : {}), ...(marks.accountLabel ? { accountLabel: marks.accountLabel } : {})
  } } });
}

const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/**
 * A current access token, refreshed when it is close to expiry or when `force` says the last one was
 * refused. The watcher, MCP servers and desktop requests share one rotating refresh token across
 * processes, and reusing an old one revokes the session, so refreshing happens under a file lock.
 */
export async function chatgptAccessToken(id: string, options: { force?: boolean | undefined } = {}, deps: ChatGptDeps = {}): Promise<string> {
  const current = await readTokens(id, deps);
  if (!current) throw new AiConnectionError(CHATGPT_SIGNED_OUT);
  if (!options.force && current.expiresAt - nowOf(deps) > REFRESH_MARGIN_MS) return current.accessToken;
  return withRefreshLock(id, deps, async () => {
    const latest = await readTokens(id, deps);
    if (!latest) throw new AiConnectionError(CHATGPT_SIGNED_OUT);
    // Another process refreshed while this one waited for the lock.
    if (latest.accessToken !== current.accessToken && latest.expiresAt - nowOf(deps) > REFRESH_MARGIN_MS) return latest.accessToken;
    const expired = latest.expiresAt <= nowOf(deps);
    if (!expired && !options.force && latest.earliestRefreshAt && nowOf(deps) < latest.earliestRefreshAt) return latest.accessToken;
    const clientId = readRecord(id, deps).clientId;
    if (!clientId) throw new AiConnectionError(CHATGPT_SIGNED_OUT);
    const result = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: latest.refreshToken, resource: CHATGPT_RESOURCE }, deps);
    if (result.status >= 300 || typeof result.json.access_token !== "string") {
      const code = typeof result.json.error === "string" ? result.json.error : "";
      if (TERMINAL_REFRESH_ERRORS.has(code)) {
        await clearSignIn(id, clientId, deps);
        throw new AiConnectionError(CHATGPT_SIGNED_OUT);
      }
      // A temporary failure keeps the sign-in; the next call tries again.
      throw new AiConnectionError(`ChatGPT sign-in could not be renewed right now (status ${result.status}). Try again shortly.`);
    }
    const tokens = tokensFrom(result.json, latest, { sub: latest.account, email: latest.email }, deps);
    await saveTokens(id, clientId, tokens, deps);
    return tokens.accessToken;
  });
}

async function clearSignIn(id: string, clientId: string | undefined, deps: ChatGptDeps): Promise<void> {
  if (clientId) await saveTokens(id, clientId, undefined, deps);
  else rmSync(recordPath(id, deps), { force: true });
  markConnection(id, {});
}

/** Signs out on this machine and asks OpenAI to revoke the refresh token; the issued client ID stays. */
export async function chatgptSignOut(id: string, deps: ChatGptDeps = {}): Promise<void> {
  const tokens = await readTokens(id, deps).catch(() => undefined);
  const clientId = readRecord(id, deps).clientId;
  await clearSignIn(id, clientId, deps);
  if (tokens && clientId) {
    try {
      await (deps.fetchImpl ?? fetch)(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: clientId }), signal: AbortSignal.timeout(10_000) });
    } catch { /* Signed out locally either way. */ }
  }
}

export interface ChatGptStatus { signedIn: boolean; registered: boolean; email?: string | undefined; expiresAt?: number | undefined }

export async function chatgptStatus(id: string, deps: ChatGptDeps = {}): Promise<ChatGptStatus> {
  const record = readRecord(id, deps);
  const tokens = await readTokens(id, deps).catch(() => undefined);
  return { signedIn: Boolean(tokens), registered: Boolean(record.clientId), ...(tokens?.email ? { email: tokens.email } : {}), ...(tokens ? { expiresAt: tokens.expiresAt } : {}) };
}

async function withRefreshLock<T>(id: string, deps: ChatGptDeps, work: () => Promise<T>): Promise<T> {
  const path = join(authDirectory(deps), `${id}.lock`);
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A holder that crashed leaves its lock behind; refreshes take seconds, not half a minute.
      try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmSync(path, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new AiConnectionError("Another Code Butler process is renewing the ChatGPT sign-in. Try again shortly.");
      await delay(100);
    }
  }
  try { return await work(); }
  finally { if (existsSync(path)) rmSync(path, { force: true }); }
}
