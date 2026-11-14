const NETWORK_CODES = ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"];

/**
 * True when this computer could not reach the network at all: no DNS, no route, refused or
 * reset connections. Narrower than the cloud classifier's message match, so it is safe for
 * errors from any stage; `fetch failed` keeps the real code in its `cause`.
 */
export function isNetworkUnavailable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.includes(code)) return true;
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (/fetch failed|getaddrinfo|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/.test(message)) return true;
  }
  return false;
}
