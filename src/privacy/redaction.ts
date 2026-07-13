export type RedactionType = "api_key" | "bearer_token" | "private_key" | "credential_url";

export interface RedactionMatch {
  type: RedactionType;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionMatch[];
}

export function redactSensitiveText(input: string): RedactionResult {
  const redactions: RedactionMatch[] = [];
  let text = input;

  text = text.replace(
    /-----BEGIN ((?:[A-Z0-9 ]*PRIVATE KEY))-----[\s\S]*?-----END \1-----/g,
    () => record(redactions, "private_key", "[REDACTED:PRIVATE_KEY]")
  );
  text = text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/:]+):([^@\s]+)@/gi,
    (_match, scheme: string) =>
      record(redactions, "credential_url", `${scheme}[REDACTED:CREDENTIALS]@`)
  );
  text = text.replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    () => record(redactions, "bearer_token", "Bearer [REDACTED:BEARER_TOKEN]")
  );
  text = text.replace(
    /\b((?:[A-Z][A-Z0-9_]*API_KEY|api[_-]?key)\s*(?:=|:)\s*["']?)([^\s"'#]+)(["']?)/gi,
    (_match, prefix: string, _secret: string, suffix: string) =>
      record(redactions, "api_key", `${prefix}[REDACTED:API_KEY]${suffix}`)
  );
  text = text.replace(
    /\b(?:sk-(?:proj-|ant-api\d*-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
    () => record(redactions, "api_key", "[REDACTED:API_KEY]")
  );

  return { text, redactions };
}

function record(redactions: RedactionMatch[], type: RedactionType, replacement: string): string {
  redactions.push({ type });
  return replacement;
}
