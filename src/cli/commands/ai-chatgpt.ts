import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

import {
  CHATGPT_CALLBACK_PATH, CHATGPT_FIRST_PORT, chatgptSignOut, chatgptStatus, completeChatGptSignIn, startChatGptSignIn
} from "../../ai/chatgpt-auth.js";
import { loadGlobalAiSettings, saveGlobalAiSettings } from "../../config.js";

const USAGE = "Usage: code-butler ai chatgpt <login|logout|status> [--connection <id>] [--no-browser]";
const CALLBACK_WAIT_MS = 10 * 60_000;

export interface ChatGptCommandOptions {
  /** Opens the sign-in page; tests replace it to drive the callback themselves. */
  openUrl?: ((url: string) => void) | undefined;
}

/** `ai chatgpt`: Sign in with ChatGPT from a terminal, for people who use Code Butler without the desktop app. */
export async function runAiCommand(args: string[], stdout: (line: string) => void, options: ChatGptCommandOptions = {}): Promise<number> {
  const [group, action, ...rest] = args;
  if (group !== "chatgpt" || !action) throw new Error(USAGE);
  const flagIndex = rest.indexOf("--connection");
  const requested = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  if (flagIndex >= 0 && !requested) throw new Error(USAGE);
  const unknown = rest.filter((arg, index) => arg !== "--no-browser" && index !== flagIndex && (flagIndex < 0 || index !== flagIndex + 1));
  if (unknown.length > 0) throw new Error(USAGE);
  if (action === "status") {
    const id = chatgptConnection(requested, false);
    const status = await chatgptStatus(id);
    stdout(`connection=${id} signedIn=${status.signedIn} registered=${status.registered}${status.email ? ` account=${status.email}` : ""}`);
    return 0;
  }
  if (action === "logout") {
    const id = chatgptConnection(requested, false);
    await chatgptSignOut(id);
    stdout(`Signed out of ChatGPT for connection ${id}`);
    return 0;
  }
  if (action !== "login") throw new Error(USAGE);
  const id = chatgptConnection(requested, true);
  const result = await signInThroughBrowser(id, rest.includes("--no-browser") ? undefined : options.openUrl ?? openInBrowser, stdout);
  stdout(`Signed in with ChatGPT${result.email ? ` as ${result.email}` : ""}; connection ${id} now uses your ChatGPT plan.`);
  return 0;
}

/** The named connection, the only ChatGPT one, or (for login) a new one called "chatgpt". */
function chatgptConnection(requested: string | undefined, create: boolean): string {
  const settings = loadGlobalAiSettings() ?? {};
  const connections = settings.connections ?? {};
  if (requested) {
    const connection = connections[requested];
    if (connection && connection.kind !== "chatgpt") throw new Error(`Connection ${requested} is not a ChatGPT plan connection`);
    if (!connection && !create) throw new Error(`No connection named ${requested}`);
    if (!connection) saveGlobalAiSettings({ ...settings, connections: { ...connections, [requested]: { kind: "chatgpt" } } });
    return requested;
  }
  const existing = Object.entries(connections).filter(([, connection]) => connection.kind === "chatgpt").map(([id]) => id);
  if (existing.length > 1) throw new Error(`Several ChatGPT connections exist (${existing.join(", ")}); choose one with --connection`);
  if (existing[0]) return existing[0];
  if (!create) throw new Error("No ChatGPT plan connection exists yet; run code-butler ai chatgpt login");
  if (connections.chatgpt) throw new Error("A connection named chatgpt already exists; choose a name with --connection");
  saveGlobalAiSettings({ ...settings, connections: { ...connections, chatgpt: { kind: "chatgpt" } } });
  return "chatgpt";
}

async function signInThroughBrowser(id: string, open: ((url: string) => void) | undefined, stdout: (line: string) => void) {
  const registered = (await chatgptStatus(id)).registered;
  // The listener starts before the browser opens, as OpenAI requires.
  const server = createServer();
  const port = await listen(server, registered ? 0 : CHATGPT_FIRST_PORT);
  try {
    const redirectUri = `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`;
    const start = await startChatGptSignIn(id, redirectUri);
    stdout(`Open this page to sign in with ChatGPT:\n${start.url}`);
    if (open) { try { open(start.url); } catch { /* The printed link still works. */ } }
    const callback = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the ChatGPT sign-in")), CALLBACK_WAIT_MS);
      timer.unref();
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== CHATGPT_CALLBACK_PATH || url.searchParams.get("state") !== start.state) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Code Butler: you can close this tab and return to the terminal.");
        clearTimeout(timer);
        resolve(url);
      });
    });
    const error = callback.searchParams.get("error");
    if (error) throw new Error(error === "access_denied" ? "ChatGPT sign-in was cancelled or not allowed" : `ChatGPT sign-in failed: ${error}`);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("ChatGPT sign-in returned no code");
    const clientId = callback.searchParams.get("client_id"), scope = callback.searchParams.get("scope");
    return await completeChatGptSignIn(id, {
      code, verifier: start.verifier, nonce: start.nonce, redirectUri,
      ...(clientId ? { clientId } : {}), ...(scope !== null ? { scope } : {})
    });
  } finally {
    server.close();
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", error => reject((error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? new Error(`Port ${port} is in use. Close any other ChatGPT or Codex sign-in that is waiting, then try again.`)
      : error));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function openInBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  const child = spawn(command, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}
