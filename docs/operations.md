# Operations

## Health and recovery

Run `code-butler doctor --json` to inspect SQLite health, schema and pending migrations, the latest migration backup, audit completeness, transaction recovery state, and embedding coverage.

Ordered migrations create a consistent `node:sqlite` backup before protected upgrades. Ordinary migration retention keeps the newest two migration backups by default and can be changed with `retention.migrationBackups`.

Privacy scrub, deletion, applied pruning, and confirmed non-empty import use separate recovery backups. A failure reports the exact retained path. Explicit `--purge-backups` removes migration and recovery copies; ordinary migration pruning never claims that explicitly deleted content has been securely purged.

## Retention

Source retention is disabled by default:

```json
{
  "retention": {
    "migrationBackups": 2,
    "sources": {
      "git": { "maxAgeDays": null },
      "codex": { "maxAgeDays": null },
      "claude": { "maxAgeDays": null },
      "manual": { "maxAgeDays": null }
    },
    "overrides": [
      { "sourceId": "temporary-source", "maxAgeDays": 7 }
    ]
  }
}
```

Exact source overrides take precedence. `null` retains indefinitely. Preview first with `privacy prune --dry-run`; mutation requires `privacy prune --apply`.

## Git sharing

New project folders expose `.code-butler/.gitignore`, `config.json`,
`memory.sqlite`, and `project-summary.md` to Git. Credentials, imports,
metadata, migration and recovery backups, and SQLite WAL/SHM sidecars remain
ignored. Stop Code Butler before committing, push before opening the project on
another device, and do not run independent writers on two devices. SQLite files
are binary: do not merge a Git conflict; recover one complete database instead.
If shutdown reports a busy WAL checkpoint, close the other SQLite reader and
retry shutdown; do not commit until it succeeds. The database contains project
memory, so use only a trusted remote.

## Portable backups

`privacy export` creates a versioned, redacted JSON document. It includes logical sources, memories, relations, lifecycle state, sync state, failures, tombstones, private identity mappings, and content-free operation records. FTS and vectors are derived: import rebuilds FTS and queues eligible embedding owners for the exported provider indexes.
