import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type AfterCommitCallback = () => void;

interface TransactionContext {
  ownsOutermostTransaction: boolean;
  callbackScopes: AfterCommitCallback[][];
}

const transactionContexts = new WeakMap<DatabaseSync, TransactionContext>();

export function afterCommit(db: DatabaseSync, callback: AfterCommitCallback): void {
  const context = transactionContexts.get(db);
  if (!context) {
    if (db.isTransaction) {
      throw new Error("Cannot schedule after-commit work from an untracked external transaction");
    }
    runAfterCommitCallbacks([callback]);
    return;
  }
  if (!context.ownsOutermostTransaction) {
    throw new Error("Cannot schedule after-commit work from an untracked external transaction");
  }
  const scope = context.callbackScopes.at(-1);
  if (!scope) throw new Error("After-commit callback scope is unavailable");
  scope.push(callback);
}

export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  const existing = transactionContexts.get(db);
  if (existing) return withSavepoint(db, existing, work);

  if (db.isTransaction) {
    const externalContext: TransactionContext = {
      ownsOutermostTransaction: false,
      callbackScopes: []
    };
    transactionContexts.set(db, externalContext);
    try {
      return withSavepoint(db, externalContext, work);
    } finally {
      transactionContexts.delete(db);
    }
  }

  const context: TransactionContext = {
    ownsOutermostTransaction: true,
    callbackScopes: [[]]
  };
  transactionContexts.set(db, context);
  let result: T;
  try {
    db.exec("BEGIN");
    result = work();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    transactionContexts.delete(db);
  }
  runAfterCommitCallbacks(context.callbackScopes[0] ?? []);
  return result;
}

function withSavepoint<T>(db: DatabaseSync, context: TransactionContext, work: () => T): T {
  const savepoint = `code_butler_${randomUUID().replaceAll("-", "")}`;
  const callbacks: AfterCommitCallback[] = [];
  db.exec(`SAVEPOINT ${savepoint}`);
  context.callbackScopes.push(callbacks);
  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    context.callbackScopes.pop();
    context.callbackScopes.at(-1)?.push(...callbacks);
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    context.callbackScopes.pop();
    throw error;
  }
}

function runAfterCommitCallbacks(callbacks: AfterCommitCallback[]): void {
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // Committed state must not be undone or later callbacks skipped by additive maintenance.
    }
  }
}
