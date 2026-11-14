// Tests Sign in with ChatGPT in src/ai/chatgpt-auth.ts: startChatGptSignIn(), completeChatGptSignIn(), chatgptAccessToken() refresh and rotation, chatgptSignOut() and deleteChatGptCredentials().
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_PLAN_REQUIRED, CHATGPT_SIGNED_OUT, chatgptAccessToken, chatgptSignOut, chatgptStatus, completeChatGptSignIn, deleteChatGptCredentials,
  startChatGptSignIn, type ChatGptDeps
} from "../../src/ai/chatgpt-auth.js";
import { setKeychainStoreForTests } from "../../src/ai/credentials.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const PLAN_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "test-key" })}.${part(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

let directory: string;
let home: string;
let secrets: Record<string, string>;
let now: number;
let deps: ChatGptDeps;
let tokenCalls: URLSearchParams[];
let tokenReplies: Array<{ status: number; body: Record<string, unknown> }>;

beforeEach(() => {
  directory = makeTempDir();
  home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  vi.stubEnv("CODE_BUTLER_HOME", home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ ai: { connections: { chatgpt: { kind: "chatgpt" } } } }));
  secrets = {};
  setKeychainStoreForTests({ get: async id => secrets[id], set: async (id, value) => { secrets[id] = value; }, delete: async id => { delete secrets[id]; } });
  now = Date.parse("2026-11-01T10:00:00Z");
  tokenCalls = [];
  tokenReplies = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url.endsWith("/oauth/token")) {
      tokenCalls.push(new URLSearchParams(String(init?.body)));
      // Refreshes take a moment, so concurrent callers really overlap.
      await new Promise(resolve => setTimeout(resolve, 20));
      const reply = tokenReplies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    if (url.endsWith("/oauth/revoke")) return new Response("{}");
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  deps = { fetchImpl, now: () => now, directory: join(home, "ai-auth"), platform: "darwin" };
});
afterEach(() => { deleteChatGptCredentials("chatgpt", deps); vi.unstubAllEnvs(); setKeychainStoreForTests(undefined); cleanupTempDir(directory); });

const config = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { ai: { connections: Record<string, Record<string, unknown>> } };
const grant = (nonce: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: {
  access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: PLAN_SCOPE, token_type: "Bearer",
  id_token: idToken({ iss: "https://auth.openai.com", aud: "oaiapp_issued", sub: "user-123", email: "person@example.com", nonce, exp: now / 1000 + 3600 }), ...extra
} });

async function signIn() {
  const start = await startChatGptSignIn("chatgpt", "http://127.0.0.1:1455/auth/callback", deps);
  tokenReplies.push(grant(start.nonce));
  await completeChatGptSignIn("chatgpt", { code: "code-1", verifier: start.verifier, nonce: start.nonce, redirectUri: "http://127.0.0.1:1455/auth/callback", clientId: "oaiapp_issued", scope: PLAN_SCOPE }, deps);
  return start;
}

describe("Sign in with ChatGPT", () => {
  it("registers on the first sign-in with PKCE, a host ID and the plan scope", async () => {
    await expect(startChatGptSignIn("chatgpt", "http://127.0.0.1:5000/auth/callback", deps)).rejects.toThrow(/needs port 1455/);
    const start = await startChatGptSignIn("chatgpt", "http://127.0.0.1:1455/auth/callback", deps);
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dynamic_agent_client", agent_name_hint: "Code Butler", response_type: "code", redirect_uri: "http://127.0.0.1:1455/auth/callback",
      scope: PLAN_SCOPE, resource: "https://api.openai.com/v1", code_challenge_method: "S256", state: start.state, nonce: start.nonce
    });
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  it("exchanges the code with the issued client ID, verifies the ID token and keeps the tokens encrypted", async () => {
    await signIn();
    expect(Object.fromEntries(tokenCalls[0]!)).toMatchObject({ grant_type: "authorization_code", client_id: "oaiapp_issued", code: "code-1", redirect_uri: "http://127.0.0.1:1455/auth/callback", resource: "https://api.openai.com/v1" });
    const stored = readFileSync(join(home, "ai-auth", "chatgpt.json"), "utf8");
    expect(stored).not.toContain("access-1");
    expect(stored).not.toContain("refresh-1");
    expect(JSON.parse(stored)).toMatchObject({ clientId: "oaiapp_issued", sealed: expect.any(Object) });
    expect(config().ai.connections.chatgpt).toMatchObject({ kind: "chatgpt", accountLabel: "person@example.com", keyUpdatedAt: expect.any(String) });
    expect(await chatgptAccessToken("chatgpt", {}, deps)).toBe("access-1");
    expect(await chatgptStatus("chatgpt", deps)).toMatchObject({ signedIn: true, registered: true, email: "person@example.com" });
  });

  it("reauthorizes with the issued client ID on any port and hints the signed-in account", async () => {
    await signIn();
    const again = new URL((await startChatGptSignIn("chatgpt", "http://127.0.0.1:61000/auth/callback", deps)).url);
    expect(again.searchParams.get("client_id")).toBe("oaiapp_issued");
    expect(again.searchParams.has("agent_name_hint")).toBe(false);
    expect(again.searchParams.get("id_token_hint")).toMatch(/^ey/);
  });

  it("rejects a token for another nonce, and a sign-in without plan usage", async () => {
    const start = await startChatGptSignIn("chatgpt", "http://127.0.0.1:1455/auth/callback", deps);
    const callback = { code: "c", verifier: start.verifier, nonce: start.nonce, redirectUri: "http://127.0.0.1:1455/auth/callback", clientId: "oaiapp_issued" };
    tokenReplies.push(grant("another-nonce"));
    await expect(completeChatGptSignIn("chatgpt", callback, deps)).rejects.toThrow(/could not be verified/);
    tokenReplies.push(grant(start.nonce, { scope: "openid profile email offline_access" }));
    await expect(completeChatGptSignIn("chatgpt", callback, deps)).rejects.toThrow(CHATGPT_PLAN_REQUIRED);
    // A free plan never gets the scope, and OpenAI then refuses the code.
    tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
    await expect(completeChatGptSignIn("chatgpt", { ...callback, scope: "openid profile email offline_access" }, deps)).rejects.toThrow(CHATGPT_PLAN_REQUIRED);
    expect(config().ai.connections.chatgpt).not.toHaveProperty("keyUpdatedAt");
    // The issued ID is kept for the retry, as OpenAI asks.
    expect((await chatgptStatus("chatgpt", deps)).registered).toBe(true);
  });

  it("refreshes once for concurrent callers and saves the rotated refresh token", async () => {
    await signIn();
    now += 3600_000;
    tokenReplies.push({ status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: PLAN_SCOPE } });
    const results = await Promise.all([chatgptAccessToken("chatgpt", {}, deps), chatgptAccessToken("chatgpt", {}, deps), chatgptAccessToken("chatgpt", {}, deps)]);
    expect(results).toEqual(["access-2", "access-2", "access-2"]);
    const refreshes = tokenCalls.filter(call => call.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(Object.fromEntries(refreshes[0]!)).toMatchObject({ client_id: "oaiapp_issued", refresh_token: "refresh-1", resource: "https://api.openai.com/v1" });
    now += 3600_000;
    tokenReplies.push({ status: 200, body: { access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 } });
    expect(await chatgptAccessToken("chatgpt", {}, deps)).toBe("access-3");
    expect(tokenCalls.at(-1)!.get("refresh_token")).toBe("refresh-2");
  });

  it("waits for earliest_refresh_at unless the token was refused", async () => {
    const start = await startChatGptSignIn("chatgpt", "http://127.0.0.1:1455/auth/callback", deps);
    tokenReplies.push(grant(start.nonce, { expires_in: 120, earliest_refresh_at: now / 1000 + 60 }));
    await completeChatGptSignIn("chatgpt", { code: "c", verifier: start.verifier, nonce: start.nonce, redirectUri: "http://127.0.0.1:1455/auth/callback", clientId: "oaiapp_issued" }, deps);
    expect(await chatgptAccessToken("chatgpt", {}, deps)).toBe("access-1");
    expect(tokenCalls).toHaveLength(1);
    tokenReplies.push({ status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 } });
    expect(await chatgptAccessToken("chatgpt", { force: true }, deps)).toBe("access-2");
  });

  it("signs out on a terminal refresh error but keeps the sign-in through a temporary one", async () => {
    await signIn();
    now += 3600_000;
    tokenReplies.push({ status: 503, body: {} });
    await expect(chatgptAccessToken("chatgpt", {}, deps)).rejects.toThrow(/could not be renewed right now/);
    expect((await chatgptStatus("chatgpt", deps)).signedIn).toBe(true);
    tokenReplies.push({ status: 400, body: { error: "refresh_token_reused" } });
    await expect(chatgptAccessToken("chatgpt", {}, deps)).rejects.toThrow(CHATGPT_SIGNED_OUT);
    expect(await chatgptStatus("chatgpt", deps)).toMatchObject({ signedIn: false, registered: true });
    expect(config().ai.connections.chatgpt).not.toHaveProperty("keyUpdatedAt");
  });

  it("signs out keeping the client ID, and removing the connection deletes everything", async () => {
    await signIn();
    await chatgptSignOut("chatgpt", deps);
    expect(await chatgptStatus("chatgpt", deps)).toMatchObject({ signedIn: false, registered: true });
    expect(config().ai.connections.chatgpt).not.toHaveProperty("accountLabel");
    deleteChatGptCredentials("chatgpt", deps);
    expect(existsSync(join(home, "ai-auth", "chatgpt.json"))).toBe(false);
  });

  it("keeps an owner-only plain record where there is no keychain", async () => {
    deps = { ...deps, platform: "linux" };
    await signIn();
    const stored = JSON.parse(readFileSync(join(home, "ai-auth", "chatgpt.json"), "utf8")) as { plain?: { accessToken: string } };
    expect(stored.plain?.accessToken).toBe("access-1");
    expect(secrets).toEqual({});
  });
});
