import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { EncryptionError } from "./crypto-helper.js";

/**
 * Snapshot format v4 carries the core database as rows, not SQLite pages.
 *
 * A page file stores absolute page numbers (overflow chains, b-tree children), so when any
 * table grows every later page changes, and two devices holding the same memories in a
 * different insertion order share almost no pages. Measured on real projects, a merge
 * re-uploaded 80% of the snapshot that way. Rows written in a canonical order and cut with
 * content-defined blocks change only where the rows changed: the same merge re-sent under
 * 1%. The search index is derived, so it is left out and rebuilt by whoever applies the
 * snapshot, which also makes the payload about 40% smaller.
 *
 * One JSON value per line. Control lines are objects — `{"format": "code-butler-rows", "version": 1}`,
 * `{"schema": [type, name, sql]}` for every table (virtual tables included), `{"rows": [table, columns]}`
 * before each table's rows, `{"schema": …}` again for indexes, triggers and views, and `{"end": rows}` —
 * and every data row is an array, so no row content can be mistaken for a control line. Integers are
 * JSON numbers (`{"i": "…"}` beyond 2^53), reals `{"r": n}`, blobs `{"b": base64}`, so every value
 * keeps its SQLite storage class.
 */
const HEADER = "code-butler-rows";
const VERSION = 1;
/** Rows in creation order, so rows added later — including a peer's merged rows — land at the end of their table. */
const ROW_ORDER: Readonly<Record<string, { join?: string; order: string }>> = {
  sources: { order: "t.created_at, t.id" },
  memories: { order: "t.created_at, t.id" },
  memory_candidates: { order: "t.created_at, t.id" },
  temporary_memories: { order: "t.created_at, t.id" },
  memory_events: { order: "t.occurred_at, t.id" },
  operation_log: { order: "t.started_at, t.id" },
  commits: { order: "t.authored_at, t.hash" },
  chunks: { join: "left join source_times s on s.id = t.source_id", order: "s.created_at, t.source_id, t.chunk_index, t.id" },
  // Re-ingesting a growing conversation replaces all of its file mentions under new random ids. Kept with
  // the source or commit they belong to, that rewrite touches a few neighbouring blocks, not hundreds.
  relations: {
    join: `left join chunks c on t.from_type = 'chunk' and c.id = t.from_id
      left join source_times s on s.id = (case t.from_type when 'source' then t.from_id when 'chunk' then c.source_id end)
      left join commits m on t.from_type = 'commit' and m.hash = t.from_id`,
    order: "coalesce(s.created_at, m.authored_at), t.from_type, t.from_id, t.relation, t.to_type, t.to_id, t.locator, t.id"
  }
};
/**
 * Each source's creation time, read once. A source row stores its whole transcript before created_at, so
 * looking the time up per chunk or relation walked those overflow pages every time: seconds per capture.
 */
const SOURCE_TIMES = "with source_times(id, created_at) as materialized (select id, created_at from sources)";
/** The absolute checkout path is device-specific; restores and merges write the local one back. */
const MASKED: Readonly<Record<string, Readonly<Record<string, string>>>> = { temporary_memories: { project_id: "'@project'" } };
const CREATE = /^\s*create\s+(?:unique\s+)?(?:virtual\s+)?(table|index|trigger|view)\s/i;

type Encoded = null | string | number | { i: string } | { r: number | string } | { b: string };
interface SchemaObject { type: string; name: string; sql: string }

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function encodeValue(value: unknown): Encoded {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { i: value.toString() };
  if (typeof value === "number") return { r: Number.isFinite(value) ? value : String(value) };
  if (value instanceof Uint8Array) return { b: Buffer.from(value).toString("base64") };
  throw new Error("Unsupported SQLite value in snapshot");
}

function decodeValue(value: unknown): null | string | bigint | number | Uint8Array {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new Error("Invalid snapshot row value"); return BigInt(value); }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof (value as { i?: unknown }).i === "string" && /^-?\d+$/.test((value as { i: string }).i)) return BigInt((value as { i: string }).i);
    if (keys.length === 1 && "r" in value) {
      const real = (value as { r: unknown }).r;
      if (typeof real === "number") return real;
      if (real === "Infinity" || real === "-Infinity") return Number(real);
    }
    if (keys.length === 1 && typeof (value as { b?: unknown }).b === "string") return Buffer.from((value as { b: string }).b, "base64");
  }
  throw new Error("Invalid snapshot row value");
}

/** Every schema object a snapshot carries, in a fixed order; FTS shadow tables are recreated by their virtual table. */
function schemaObjects(db: DatabaseSync): { tables: SchemaObject[]; later: SchemaObject[]; shadow: Set<string> } {
  const shadow = new Set((db.prepare("pragma table_list").all() as Array<{ name: string; type: string }>).filter(t => t.type === "shadow").map(t => t.name));
  const objects = (db.prepare("select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by name").all() as unknown as SchemaObject[])
    .filter(o => !shadow.has(o.name));
  const rank: Record<string, number> = { index: 0, trigger: 1, view: 2 };
  return {
    tables: objects.filter(o => o.type === "table"),
    later: objects.filter(o => o.type !== "table").sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    shadow
  };
}

const isVirtual = (object: SchemaObject) => /^\s*create\s+virtual\s+table/i.test(object.sql);

export function encodeRowStream(databasePath: string): Buffer {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const parts: Buffer[] = [];
  const line = (value: unknown) => parts.push(Buffer.from(`${JSON.stringify(value)}\n`));
  let rows = 0;
  try {
    const { tables, later } = schemaObjects(db);
    line({ format: HEADER, version: VERSION });
    for (const table of tables) line({ schema: [table.type, table.name, table.sql] });
    // sqlite_sequence is left out: its only table is the retrieval journal, which a capture empties and a restore re-identifies.
    for (const name of tables.filter(table => !isVirtual(table)).map(table => table.name)) {
      const columns = (db.prepare(`pragma table_info(${quote(name)})`).all() as Array<{ name: string; pk: number }>);
      const key = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => quote(c.name));
      const { join, order } = ROW_ORDER[name] ?? { order: (key.length ? key : columns.map(c => quote(c.name))).map(column => `t.${column}`).join(", ") };
      const select = columns.map(c => MASKED[name]?.[c.name] ?? `t.${quote(c.name)}`).join(", ");
      line({ rows: [name, columns.map(c => c.name)] });
      const statement = db.prepare(`${join ? `${SOURCE_TIMES} ` : ""}select ${select} from ${quote(name)} as t ${join ?? ""} order by ${order}`);
      statement.setReadBigInts(true);
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        parts.push(Buffer.from(`${JSON.stringify(Object.values(row).map(encodeValue))}\n`));
        rows += 1;
      }
    }
    for (const object of later) line({ schema: [object.type, object.name, object.sql] });
    line({ end: rows });
  } finally { db.close(); }
  return Buffer.concat(parts);
}

/** Runs exactly one CREATE statement for the named object and confirms that is what it made. */
function create(db: DatabaseSync, object: SchemaObject): void {
  const kind = CREATE.exec(object.sql)?.[1]?.toLowerCase();
  if (kind !== object.type || typeof object.name !== "string" || object.name.startsWith("sqlite_")) throw new Error("Invalid snapshot schema");
  // `prepare` compiles only the first statement, so text after it can never run.
  db.prepare(object.sql).run();
  if (!db.prepare("select 1 from sqlite_master where type = ? and name = ?").get(object.type, object.name)) throw new Error("Invalid snapshot schema");
}

/** Builds a SQLite database from a v4 row stream; the caller verifies it like any received snapshot. */
export function buildDatabaseFromRowStream(bytes: Buffer, databasePath: string): void {
  const discard = () => { for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${databasePath}${suffix}`, { force: true }); };
  discard();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("pragma page_size = 4096; pragma journal_mode = off; pragma synchronous = off; pragma foreign_keys = off; begin");
    const text = bytes.toString("utf8"), tables = new Set<string>();
    let offset = 0, header = false, ended = false, rowsSeen = false, rows = 0, width = 0;
    let insert: ReturnType<DatabaseSync["prepare"]> | undefined;
    const invalid = (): never => { throw new Error("Invalid snapshot row stream"); };
    while (offset < text.length) {
      const end = text.indexOf("\n", offset);
      if (end < 0 || ended) invalid();
      const value: unknown = JSON.parse(text.slice(offset, end)); offset = end + 1;
      if (Array.isArray(value)) {
        if (!insert || value.length !== width) invalid();
        insert!.run(...value.map(decodeValue)); rows += 1; continue;
      }
      if (!value || typeof value !== "object") invalid();
      const control = value as Record<string, unknown>, keys = Object.keys(control);
      if (!header) {
        if (control.format !== HEADER || keys.length !== 2) invalid();
        if (control.version !== VERSION) throw new EncryptionError("incompatible-format");
        header = true; continue;
      }
      insert = undefined;
      if (keys.length !== 1) invalid();
      if (Array.isArray(control.schema) && control.schema.length === 3 && control.schema.every(part => typeof part === "string")) {
        const [type, name, sql] = control.schema as [string, string, string];
        // Tables come first, indexes, triggers and views only after every row, so no trigger fires during the build.
        if ((type === "table") === rowsSeen) invalid();
        create(db, { type, name, sql });
        if (type === "table") tables.add(name);
      } else if (Array.isArray(control.rows) && control.rows.length === 2 && typeof control.rows[0] === "string" && Array.isArray(control.rows[1])) {
        const [name, columns] = control.rows as [string, unknown[]];
        if (!columns.length || !columns.every(column => typeof column === "string") || !tables.has(name)) invalid();
        rowsSeen = true;
        insert = db.prepare(`insert into ${quote(name)} (${(columns as string[]).map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})`);
        width = columns.length;
      } else if (typeof control.end === "number" && control.end === rows) {
        ended = true;
      } else invalid();
    }
    if (!header || !ended) invalid();
    db.exec("commit");
  } catch (error) {
    try { if (db.isTransaction) db.exec("rollback"); } catch { /* The file is discarded below. */ }
    db.close(); discard();
    throw error;
  }
  db.close();
}
