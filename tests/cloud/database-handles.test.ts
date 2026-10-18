// Tests assertNoDatabaseHandles() and handleOwnerPid() in src/cloud/gate.ts against crash-damaged handle files.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertNoDatabaseHandles, handleOwnerPid } from "../../src/cloud/gate.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) cleanupTempDir(path); });
function handles(): { root: string; dir: string } {
  const root = makeTempDir(); roots.push(root);
  const dir = join(root, ".code-butler", ".cloud-handles"); mkdirSync(dir, { recursive: true });
  return { root, dir };
}
// What a power loss can leave behind on NTFS: the file's length survived, its bytes did not.
const zeroFilled = Buffer.alloc(13);

describe("database handles", () => {
  it("reads the owner from the name registerDatabaseHandle writes", () => {
    const id = randomUUID();
    expect(handleOwnerPid(`18572-${id}.json`)).toBe(18572);
    expect(handleOwnerPid(`18572-${id}.json.tmp`)).toBeUndefined();
    expect(handleOwnerPid("desktop.ini")).toBeUndefined();
  });

  it("removes a zero-filled handle whose process is gone instead of failing the restore", () => {
    const { root, dir } = handles();
    const dead = join(dir, `99999999-${randomUUID()}.json`); writeFileSync(dead, zeroFilled);
    expect(() => assertNoDatabaseHandles(root)).not.toThrow();
    expect(existsSync(dead)).toBe(false);
  });

  it("still defers for a live owner, whatever the file holds, and leaves files it did not write alone", () => {
    const { root, dir } = handles();
    const foreign = join(dir, "desktop.ini"); writeFileSync(foreign, "not json");
    expect(() => assertNoDatabaseHandles(root)).not.toThrow();
    expect(existsSync(foreign)).toBe(true);
    const live = join(dir, `${process.pid}-${randomUUID()}.json`); writeFileSync(live, zeroFilled);
    expect(() => assertNoDatabaseHandles(root)).toThrow("Cloud restore deferred");
    expect(existsSync(live)).toBe(true);
  });
});
