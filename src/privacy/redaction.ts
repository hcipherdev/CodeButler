export type RedactionType =
  | "api_key"
  | "bearer_token"
  | "private_key"
  | "credential_url"
  | "github_token"
  | "gitlab_token"
  | "slack_token"
  | "google_api_key"
  | "npm_token"
  | "stripe_key"
  | "aws_secret_access_key"
  | "configured_pattern";

export interface RedactionMatch {
  type: RedactionType;
  ruleName?: string;
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
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    () => record(redactions, "github_token", "[REDACTED:GITHUB_TOKEN]")
  );
  text = text.replace(
    /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    () => record(redactions, "gitlab_token", "[REDACTED:GITLAB_TOKEN]")
  );
  text = text.replace(
    /\bxox[a-z]-[A-Za-z0-9-]{20,}\b/g,
    () => record(redactions, "slack_token", "[REDACTED:SLACK_TOKEN]")
  );
  text = text.replace(
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    () => record(redactions, "google_api_key", "[REDACTED:GOOGLE_API_KEY]")
  );
  text = text.replace(
    /\bnpm_[A-Za-z0-9]{20,}\b/g,
    () => record(redactions, "npm_token", "[REDACTED:NPM_TOKEN]")
  );
  text = text.replace(
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    () => record(redactions, "stripe_key", "[REDACTED:STRIPE_KEY]")
  );
  text = text.replace(
    /\b(AWS_SECRET_ACCESS_KEY\s*(?:=|:)\s*["']?)([A-Za-z0-9/+=]{32,})(["']?)/gi,
    (_match, prefix: string, _secret: string, suffix: string) =>
      record(redactions, "aws_secret_access_key", `${prefix}[REDACTED:AWS_SECRET_ACCESS_KEY]${suffix}`)
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
    (match, prefix: string, secret: string, suffix: string) =>
      secret.startsWith("[REDACTED:")
        ? match
        : record(redactions, "api_key", `${prefix}[REDACTED:API_KEY]${suffix}`)
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
