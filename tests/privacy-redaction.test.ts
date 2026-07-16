import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../src/privacy/redaction.js";
import { createRedactionPolicy, redactWithPolicy } from "../src/privacy/policy.js";

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

  it.each([
    ["github_token", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
    ["github_token", "github_pat_11AA0abcdefghijklmnopqrstuvwxyz1234567890"],
    ["gitlab_token", "glpat-abcdefghijklmnopqrst"],
    ["slack_token", "xoxb-FAKE-FIXTURE-NOT-REAL-abcdefghijklmnopqrstuvwx"],
    ["google_api_key", "AIzaFakeGoogleAPITestKeyNotReal12345678"],
    ["npm_token", "npm_abcdefghijklmnopqrstuvwxyz1234567890"],
    ["stripe_key", "sk_test_FakeNotReal12345678"],
    ["api_key", "AKIAABCDEFGHIJKLMNOP"],
    ["aws_secret_access_key", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"]
  ] as const)("redacts common %s fixtures", (type, secret) => {
    const result = redactSensitiveText(`before ${secret} after`);

    expect(result.text).not.toContain(secret);
    expect(result.redactions).toContainEqual(expect.objectContaining({ type }));
  });

  it("applies named literal and regular-expression project rules without reporting matches", () => {
    const literalSecret = "company-internal-password";
    const regexSecret = "TENANT-SECRET-4815162342";
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [
        { name: "internal password", kind: "literal", pattern: literalSecret },
        { name: "tenant secret", kind: "regex", pattern: "TENANT-SECRET-[0-9]+" }
      ]
    });

    const result = redactWithPolicy(`${literalSecret}\n${regexSecret}`, policy);

    expect(result.text).toBe("[REDACTED:PROJECT_PATTERN]\n[REDACTED:PROJECT_PATTERN]");
    expect(JSON.stringify(result.redactions)).not.toContain(literalSecret);
    expect(JSON.stringify(result.redactions)).not.toContain(regexSecret);
    expect(result.redactions).toEqual([
      { type: "configured_pattern", ruleName: "internal password" },
      { type: "configured_pattern", ruleName: "tenant secret" }
    ]);
  });

  it("is idempotent and applies overlapping configured rules in declared order", () => {
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [
        { name: "long form", kind: "literal", pattern: "tenant-secret-123" },
        { name: "short form", kind: "literal", pattern: "tenant-secret" }
      ]
    });

    const once = redactWithPolicy("tenant-secret-123", policy);
    const twice = redactWithPolicy(once.text, policy);

    expect(once.text).toBe("[REDACTED:PROJECT_PATTERN]");
    expect(once.redactions).toEqual([{ type: "configured_pattern", ruleName: "long form" }]);
    expect(twice).toEqual({ text: once.text, redactions: [] });
  });

  it("protects existing redaction markers from built-in and configured rules", () => {
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "marker word", kind: "literal", pattern: "REDACTED" }]
    });
    const marker = "OPENAI_API_KEY=[REDACTED:API_KEY] [REDACTED:PROJECT_PATTERN]";

    expect(redactWithPolicy(marker, policy)).toEqual({ text: marker, redactions: [] });
  });

  it("returns an immutable compiled policy", () => {
    const policy = createRedactionPolicy({
      allowRemoteEmbeddings: false,
      redactionPatterns: [{ name: "tenant", kind: "literal", pattern: "tenant-secret" }]
    });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules[0])).toBe(true);
    expect(() => {
      (policy.rules as unknown as Array<unknown>).push("unsafe");
    }).toThrow();
  });
});
