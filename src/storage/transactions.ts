import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (!db.isTransaction) {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  const savepoint = `code_butler_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
