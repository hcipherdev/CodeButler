import { z } from "zod";
import type { MemoryLayer, MemoryLayerFilter, ParsedMemoryLayer } from "../types.js";
import type { StorageContentPolicy } from "../storage/content-policy.js";
import { installationDeviceId } from "./origin.js";

export const CORE_LAYER: MemoryLayer = "core";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Git refnames cannot contain ':', so 'branch:<name>:device:<id>' never parses ambiguously. */
const branchName = /^[^\s:~^?*\[\\]{1,200}$/;
export const memoryLayerSchema = z.string().trim().min(1).max(300).refine(value => {
  try { parseLayer(value); return true; } catch { return false; }
}, "Layer must be core, device:<uuid>, branch:<name>, or branch:<name>:device:<uuid>");
export const memoryLayerInputSchema = z.string().trim().min(1).max(300).refine(value => {
  try {
    if (value.trim().toLowerCase() === "device") return true;
    parseLayer(value);
    return true;
  } catch { return false; }
}, "Layer must be core, device, device:<uuid>, branch:<name>, or branch:<name>:device:<uuid>");
export const memoryLayerFilterSchema = z.enum(["core", "device", "branch", "all"]);
/** Whose layer, as opposed to which kind of layer. Defaults to this device's own. */
export const memoryLayerOwnerSchema = z.enum(["self", "peer", "any"]);

function invalidBranch(name: string): boolean {
  return !branchName.test(name) || name.startsWith("-") || name.includes("..") || name.endsWith(".lock") || name === "@";
}
export function parseLayer(raw: string | null | undefined): ParsedMemoryLayer {
  const value = (raw ?? CORE_LAYER).trim();
  if (!value || value.toLowerCase() === CORE_LAYER) return { kind: "core" };
  const device = /^device:(.+)$/i.exec(value);
  if (device) {
    const deviceId = device[1]!.trim().toLowerCase();
    if (!uuid.test(deviceId)) throw new Error("Device layer requires a UUID device id");
    return { kind: "device", deviceId };
  }
  const branch = /^branch:([^:]+)(?::device:(.+))?$/i.exec(value);
  if (branch) {
    const name = branch[1]!.trim();
    if (invalidBranch(name)) throw new Error("Branch layer requires a valid git branch name");
    if (branch[2] === undefined) return { kind: "branch", branch: name };
    const deviceId = branch[2].trim().toLowerCase();
    if (!uuid.test(deviceId)) throw new Error("Device layer requires a UUID device id");
    return { kind: "branch", branch: name, deviceId };
  }
  throw new Error("Layer must be core, device:<uuid>, branch:<name>, or branch:<name>:device:<uuid>");
}
export function formatLayer(parsed: ParsedMemoryLayer): MemoryLayer {
  if (parsed.kind === "core") return CORE_LAYER;
  if (parsed.kind === "device") return `device:${parsed.deviceId}`;
  return `branch:${parsed.branch}${parsed.deviceId ? `:device:${parsed.deviceId}` : ""}`;
}
export function normalizeLayer(value: unknown): MemoryLayer {
  if (value === undefined || value === null) return CORE_LAYER;
  if (typeof value !== "string") throw new Error("Layer must be a string");
  return formatLayer(parseLayer(value));
}
export function normalizeLayerInput(value: unknown): MemoryLayer {
  if (typeof value === "string" && value.trim().toLowerCase() === "device") return deviceLayer();
  return normalizeLayer(value);
}
/** Branch names are user data; redact them at the storage boundary like other text. */
export function sanitizeLayer(policy: StorageContentPolicy, value: unknown): MemoryLayer {
  const parsed = parseLayer(normalizeLayer(value));
  if (parsed.kind !== "branch") return formatLayer(parsed);
  return formatLayer({ ...parsed, branch: policy.text(parsed.branch!) });
}
export function sanitizeLayerInput(policy: StorageContentPolicy, value: unknown): MemoryLayer {
  return sanitizeLayer(policy, normalizeLayerInput(value));
}
export function deviceLayer(deviceId: string = installationDeviceId()): MemoryLayer {
  return formatLayer({ kind: "device", deviceId: deviceId.trim().toLowerCase() });
}
export function isCoreLayer(value: string | null | undefined): boolean {
  return parseLayer(value).kind === "core";
}
export function matchesLayerFilter(value: string | null | undefined, filter?: MemoryLayerFilter): boolean {
  if (filter === undefined || filter === "all") return true;
  return parseLayer(value).kind === filter;
}
export function layerLabel(value: string | null | undefined): string {
  const parsed = parseLayer(value);
  if (parsed.kind === "core") return "Core (shared across devices)";
  if (parsed.kind === "device") return `Device-local (${parsed.deviceId})`;
  return `Branch ${parsed.branch}${parsed.deviceId ? ` on device ${parsed.deviceId}` : ""} (local)`;
}

export const LAYER_GUIDANCE = " Each memory reports the layer it lives in. Core memories are shared project truths. Device and branch layers belong to one machine: this device's own are returned by default, and another device's are read-only here — pass owner: \"peer\" to see what another device is working on, and never try to edit or promote one, because its owning device republishes it on every sync.";
