import type { DatabaseSync, StatementSync } from "node:sqlite";

const STATEMENT_LIMIT = 256;
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * Reuses one compiled statement per connection and SQL text for reads that run once per memory.
 * Only use the result with get() or all(): they finish and reset the statement before returning,
 * whereas an open iterate() would be disturbed by a nested call with the same SQL.
 */
export function prepareCached(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) return existing;
  const statement = db.prepare(sql);
  if (cache.size >= STATEMENT_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(sql, statement);
  return statement;
}
