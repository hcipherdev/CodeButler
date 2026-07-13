import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../src/privacy/redaction.js";

describe("privacy redaction", () => {
  it("redacts API keys while preserving their labels", () => {
    const result = redactSensitiveText([
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "api_key: custom-secret-value-1234567890"
    ].join("\n"));

    expect(result.text).toBe([
      "OPENAI_API_KEY=[REDACTED:API_KEY]",
      "api_key: [REDACTED:API_KEY]"
    ].join("\n"));
    expect(result.redactions.filter(({ type }) => type === "api_key")).toHaveLength(2);
  });

  it("redacts bearer tokens case-insensitively", () => {
    const result = redactSensitiveText("Authorization: bearer eyJhbGciOi.secret.signature");

    expect(result.text).toBe("Authorization: Bearer [REDACTED:BEARER_TOKEN]");
    expect(result.redactions).toEqual([expect.objectContaining({ type: "bearer_token" })]);
  });

  it("redacts complete private-key blocks", () => {
    const result = redactSensitiveText([
      "before",
      "-----BEGIN PRIVATE KEY-----",
      "c2VjcmV0LWtleS1tYXRlcmlhbA==",
      "-----END PRIVATE KEY-----",
      "after"
    ].join("\n"));

    expect(result.text).toBe("before\n[REDACTED:PRIVATE_KEY]\nafter");
    expect(result.redactions).toEqual([expect.objectContaining({ type: "private_key" })]);
  });

  it("redacts credentials embedded in URLs without removing the host", () => {
    const result = redactSensitiveText("Clone https://alice:p%40ss@example.com/org/repo.git now.");

    expect(result.text).toBe("Clone https://[REDACTED:CREDENTIALS]@example.com/org/repo.git now.");
    expect(result.redactions).toEqual([expect.objectContaining({ type: "credential_url" })]);
  });

  it("leaves ordinary source text and credential-free URLs unchanged", () => {
    const text = "Read https://example.com/docs and src/privacy/redaction.ts.";
    expect(redactSensitiveText(text)).toEqual({ text, redactions: [] });
  });
});
