import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeRetrievalReaders } from "./index.js";
import { retrievalPaths, revokeRetrieval } from "./paths.js";
/** Revoke before deleting bytes. A concurrent publisher cannot publish an older epoch. */
export function purgeRetrieval(root: string): void {
    const paths = retrievalPaths(root);
    if (!existsSync(paths.directory))
        return;
    revokeRetrieval(root);
    closeRetrievalReaders(root);
    for (const name of readdirSync(paths.directory).filter(name => /^index(?:-[a-f0-9-]+)?\.sqlite$/.test(name))) {
        const path = join(paths.directory, name);
        const db = new DatabaseSync(path);
        let corrupt = false;
        try {
            const tables = new Set((db.prepare("select name from sqlite_master where type='table'").all() as Array<{
                name: string;
            }>).map(row => row.name));
            db.exec("pragma busy_timeout=5000; pragma secure_delete=ON; begin immediate");
            // An interrupted first build can have only part of the derived schema.
            for (const table of ["records", "record_fts", "dependencies", "quote_chunks", "raw_fts", "source_metadata", "semantic_vectors", "file_observations", "publication"])
                if (tables.has(table))
                    db.exec(`delete from ${table}`);
            db.exec("commit");
            for (const table of ["record_fts", "raw_fts"])
                if (tables.has(table))
                    db.exec(`insert into ${table}(${table}) values('optimize')`);
            db.exec("vacuum");
            const checkpoint = db.prepare("pragma wal_checkpoint(TRUNCATE)").get() as {
                busy: number;
            };
            if (checkpoint.busy)
                throw new Error("Privacy cleanup is waiting for a memory reader to release its snapshot; retry the operation.");
        }
        catch (error) {
            if (!/malformed|not a database/i.test(String(error)))
                throw error;
            corrupt = true;
        }
        finally {
            if (db.isTransaction)
                db.exec("rollback");
            db.close();
        }
        if (corrupt)
            for (const suffix of ["", "-wal", "-shm"])
                rmSync(path + suffix, { force: true });
    }
    for (const name of readdirSync(paths.directory))
        if (name.startsWith("capture-") || /^assessment\.sqlite(?:-wal|-shm)?$/.test(name)) {
            // Only a direct child created by captureRetrieval is eligible for deletion.
            const path = join(paths.directory, name);
            rmSync(path, { recursive: true, force: true });
        }
}
