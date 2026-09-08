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

Code Butler project state lives under `.code-butler/`. Treat that directory as
local runtime state by default. Only commit files that are intentionally useful
to collaborators, such as `.code-butler/.gitignore`,
`.code-butler/project-summary.md`, and a secret-free `.code-butler/config.json`.

Never commit `.code-butler/memory.sqlite`, SQLite WAL/SHM sidecars, sync
metadata, imports, logs, staging files, or migration and recovery backups. If a
database file was already staged or tracked, stop Code Butler and remove it from
Git while keeping the local copy:

```bash
git rm --cached --ignore-unmatch .code-butler/memory.sqlite
git rm --cached --ignore-unmatch .code-butler/memory.sqlite-wal .code-butler/memory.sqlite-shm
```

Then commit the ignore-file and documentation changes. SQLite files are binary;
do not resolve database conflicts by merging them. Keep one complete database
copy, restore from a backup or export when needed, and restart Code Butler after
the Git operation is clean.

## Portable backups

`privacy export` creates a versioned, redacted JSON document. It includes logical sources, memories, relations, lifecycle state, sync state, failures, tombstones, private identity mappings, and content-free operation records. FTS and vectors are derived: import rebuilds FTS and queues eligible embedding owners for the exported provider indexes.
