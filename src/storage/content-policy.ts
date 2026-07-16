import { createHash } from "node:crypto";

import {
  createRedactionPolicy,
  redactWithPolicy,
  type RedactionPolicy
} from "../privacy/policy.js";
import type { EvidenceRef, PrivacyConfig } from "../types.js";

export interface StorageContentPolicy {
  readonly privacyPolicy: RedactionPolicy;
  text(value: string): string;
  identifier(value: string): string;
  locator(value: string): string;
  path(value: string): string;
  json<T>(value: T): T;
  evidence(value: readonly EvidenceRef[]): EvidenceRef[];
}

const DEFAULT_PRIVACY: PrivacyConfig = Object.freeze({ allowRemoteEmbeddings: false });

export function createStorageContentPolicy(
  privacyPolicy: RedactionPolicy = createRedactionPolicy(DEFAULT_PRIVACY)
): StorageContentPolicy {
  const immutablePolicy = Object.freeze({
    rules: Object.freeze(privacyPolicy.rules.map((rule) => Object.freeze({ ...rule })))
  });
  const text = (value: string): string => redactWithPolicy(value, immutablePolicy).text;
  const identifier = (value: string): string =>
    text(value) === value ? value : `redacted-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
  const locator = (value: string): string => {
    const chunk = /^(.*):chunk:(\d+)$/.exec(value);
    return chunk ? `${identifier(chunk[1] ?? "")}:chunk:${chunk[2]}` : identifier(value);
  };
  const json = <T>(value: T): T => sanitizeJson(value, text, identifier) as T;
  const evidence = (value: readonly EvidenceRef[]): EvidenceRef[] =>
    value.map((item) => ({
      sourceType: item.sourceType,
      sourceId: identifier(item.sourceId),
      ...(item.locator === undefined ? {} : { locator: locator(item.locator) })
    }));
  return Object.freeze({
    privacyPolicy: immutablePolicy,
    text,
    identifier,
    locator,
    path: identifier,
    json,
    evidence
  });
}

function sanitizeJson(
  value: unknown,
  text: (value: string) => string,
  identifier: (value: string) => string
): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, text, identifier));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [identifier(key), sanitizeJson(item, text, identifier)])
  );
}
