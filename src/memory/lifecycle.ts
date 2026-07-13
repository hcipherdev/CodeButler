import type { MemoryType } from "../types.js";

export function createMemorySubjectKey(type: MemoryType, title: string): string {
  const normalizedTitle = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${type}:${normalizedTitle || "untitled"}`;
}
