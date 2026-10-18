// Tests handbook backup retention and explicit privacy backup purging without removing unrelated files.
import { afterEach, expect, it } from "vitest";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemoryStore } from "../../src/storage/store.js";
import { exportMemoryHandbook, purgeHandbookExportBackups } from "../../src/memory/export.js";
import { deletePrivacySource } from "../../src/privacy/service.js";
import { rememberProjectMemory } from "../../src/memory/remember.js";
import { inspectArtifactMaintenance, runArtifactMaintenance } from "../../src/maintenance/artifacts.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp.js";
const roots: string[] = [], stores: ReturnType<typeof openMemoryStore>[] = [];
afterEach(() => { for (const store of stores.splice(0))
    store.close(); for (const root of roots.splice(0))
    cleanupTempDir(root); });
function fixture() {
    const root = makeTempDir();
    roots.push(root);
    const store = openMemoryStore(root);
    store.init();
    stores.push(store);
    const memory = rememberProjectMemory(store, { type: "decision", text: "Keep publication manual.", scope: { kind: "project" } });
    const exported = exportMemoryHandbook(store);
    for (let i = 0; i < 2; i++) {
        writeFileSync(join(exported.directory, "decisions.md"), `Edited draft ${i}`);
        exportMemoryHandbook(store, { force: true });
    }
    const directory = join(root, ".code-butler/backups/handbook"), files = readdirSync(directory).map(file => join(directory, file)).sort();
    files.forEach((file, i) => utimesSync(file, new Date(`2026-09-0${i + 1}`), new Date(`2026-09-0${i + 1}`)));
    const unrelated = join(directory, "human-notes.md");
    writeFileSync(unrelated, "Keep my notes");
    return { root, store, memory, directory, files, unrelated };
}
it("retains only the configured newest generated backups and leaves dry runs unchanged", () => {
    const { root, files, unrelated } = fixture();
    const config = { logs: { maxBytes: 1024, maxFiles: 1 }, projectSummaryBackups: { maxFiles: 1 },
        recoveryBackups: { maxFiles: 1, minAgeDays: 7 }, cloudHandles: { reapStale: false } };
    const inspection = inspectArtifactMaintenance(root, config);
    expect(inspection.items.filter(i => i.category === "handbookBackups").map(i => i.path)).toEqual([files[0]]);
    expect(files.every(existsSync)).toBe(true);
    runArtifactMaintenance(root, config, { apply: true });
    expect(existsSync(files[0]!)).toBe(false);
    expect(existsSync(files[1]!)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
});
it("includes generated Markdown backups in explicit privacy purging", () => {
    const { root, store, memory, files, unrelated } = fixture();
    const result = deletePrivacySource(store, { sourceId: memory.sourceId, confirmSourceId: memory.sourceId, purgeBackups: true });
    expect(result.purge?.removed).toEqual(expect.arrayContaining(files));
    expect(files.some(existsSync)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(purgeHandbookExportBackups(root).removed).toEqual([]);
});
