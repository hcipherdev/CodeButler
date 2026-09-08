import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config.js";
import type { MemoryOrigin } from "../types.js";
import type { StorageContentPolicy } from "../storage/content-policy.js";

const originSchema = z.object({
  deviceId: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1),
  generatedAt: z.string().datetime(),
  method: z.enum(["deterministic", "llm", "manual"]),
  channel: z.enum(["sync", "cli", "mcp"]),
  client: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  generator: z.object({ provider: z.string().optional(), model: z.string().optional() }).optional()
});

export function parseMemoryOrigin(raw: string | null | undefined): MemoryOrigin | null {
  if (raw == null) return null;
  try { return originSchema.parse(JSON.parse(raw)) as MemoryOrigin; }
  catch { throw new Error("Invalid memory origin metadata"); }
}

export function sanitizeMemoryOrigin(policy: StorageContentPolicy, origin: MemoryOrigin | null | undefined): MemoryOrigin | null {
  if (origin == null) return null;
  const valid = parseMemoryOrigin(JSON.stringify(origin))!;
  return {
    ...valid,
    deviceId: policy.identifier(valid.deviceId),
    platform: policy.text(valid.platform), arch: policy.text(valid.arch),
    ...(valid.client ? { client: policy.json(valid.client) } : {}),
    ...(valid.generator ? { generator: policy.json(valid.generator) } : {})
  };
}

/** Publish a fully written identity without replacing a concurrent writer's identity. */
export function installationDeviceId(directory = globalConfigDir()): string {
  const target = join(directory, "device.json");
  const read = (): string => {
    const value: unknown = JSON.parse(readFileSync(target, "utf8"));
    return z.object({ deviceId: z.string().uuid() }).parse(value).deviceId;
  };
  try { return read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.device-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ deviceId: randomUUID() }) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temporary); }
  return read();
}

export type OriginContext = Pick<MemoryOrigin, "method" | "channel" | "client" | "generator">;
export type OriginFactory = (context: OriginContext) => MemoryOrigin;
export function createMemoryOrigin(context: OriginContext, environment: {
  directory?: string; platform?: string; arch?: string; now?: () => Date;
} = {}): MemoryOrigin {
  return {
    ...context,
    deviceId: installationDeviceId(environment.directory),
    platform: environment.platform ?? process.platform,
    arch: environment.arch ?? process.arch,
    generatedAt: (environment.now?.() ?? new Date()).toISOString()
  };
}

export function formatMemoryOrigin(origin: MemoryOrigin | null | undefined): string {
  return origin ? `Origin: ${origin.platform}/${origin.arch}, ${origin.method} via ${origin.channel}, ${origin.generatedAt} (installation ${origin.deviceId})` : "Origin: unknown";
}
