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

## Automatic promotion

After every sync Butler promotes corroborated memories to durable `core` memory. Merged
branch and device memories move to `core` through the layer score. Candidates already in
`core` (findings on the default branch) are promoted in place when one of these holds:

| Signal | Confidence bar |
|---|---|
| A person verified it (desktop or CLI) | none |
| Its evidence spans two or more independent sources (commits or sessions) | `promotion.confidenceThreshold` (0.85) |
| An AI review judged it current (not a replacement the AI review wrote itself) | `promotion.automatic.singleSourceMinConfidence` (0.90) |

The candidate must also be `active` quality. Verification by an MCP agent never counts.
An equivalent `core` fact is converged on instead of duplicated, and a contradicting one
defers the candidate as `needs_review`. Confidence is the extractor's own rating, so the
bars are coarse cuts rather than probabilities.

```json
{
  "promotion": {
    "confidenceThreshold": 0.85,
    "automatic": { "enabled": true, "coreCandidates": true, "singleSourceMinConfidence": 0.9 }
  }
}
```

```bash
code-butler memory promotions --plan                      # preview; writes nothing
code-butler memory promotions --apply                     # run a pass now instead of waiting for sync
code-butler memory promotions --history                   # decisions already taken on this device
code-butler memory promotions --undo --since 2026-10-09T00:00:00Z
code-butler memory promotions --undo --id <candidate-id>
```

Undo covers core-candidate promotions this device decided. It withdraws (retracts) the
durable copy and returns the candidate to candidate state; nothing is deleted, and both
changes sync to other devices. An undone candidate is not promoted again until a person
verifies it, which restores the same durable row. Set
`promotion.automatic.coreCandidates: false` to stop promoting `core` candidates.

## Layer retention

Durable device- and branch-layer memories have no TTL of their own, so a separate
retention pass ages them out. It is conservative by default: only a branch layer
whose branch no longer exists locally is archived, and only after the grace period.

```json
{
  "retention": {
    "layers": {
      "enabled": true,
      "graceDays": 30,
      "branch": { "onDeleted": "archive", "onMerged": "keep", "maxIdleDays": null },
      "device": { "maxIdleDays": null }
    }
  }
}
```

Archiving is reversible and destroys nothing: a promoted memory is retracted and can
be restored with `memory status --status current`, and a candidate is quarantined with
a `layer_retention_archived` quality reason. `core` memories are never touched, merged
branches are left to promotion and triage, and an explicit `retain_branch` triage
review always outranks the policy. Without a readable Git repository every branch
classifies as unknown and nothing is archived.

The pass runs after automatic promotion on every sync, so knowledge that has earned
`core` is shared before its branch-local copy expires. Preview it with
`code-butler memory retention` or `explain_layer_retention`, apply it out of band with
`code-butler memory retention --apply`, and read what it did with
`code-butler memory retention --history`. Set `retention.layers.enabled: false` to turn
it off.

## Artifact retention

Non-memory runtime artifacts are bounded automatically. The pass is conservative,
touches nothing under `memory.sqlite`, `memory.sqlite-wal`, or `memory.sqlite-shm`,
and removes a file only when it is provably replaceable.

```json
{
  "retention": {
    "artifacts": {
      "logs": { "maxBytes": 5242880, "maxFiles": 3 },
      "projectSummaryBackups": { "maxFiles": 5 },
      "recoveryBackups": { "maxFiles": 5, "minAgeDays": 7 },
      "cloudHandles": { "reapStale": true }
    }
  }
}
```

- `logs/watch.out.log` and `logs/watch.err.log` rotate at watcher startup and before
  each watcher sync cycle once they exceed `logs.maxBytes`, keeping `logs.maxFiles`
  rotated copies.
- `backups/project-summary/*.md` is pruned to the newest `projectSummaryBackups.maxFiles`
  after a successful summary refresh.
- `memory.sqlite.recovery-*.sqlite` is pruned to the newest `recoveryBackups.maxFiles`
  and only among backups older than `recoveryBackups.minAgeDays`, so a fresh recovery
  copy is never removed.
- `.cloud-handles/*.json` and `.cloud-owner-*` files are reaped only when the recorded
  PID is not alive.

Preview with `code-butler maintenance status --json` or
`code-butler maintenance prune --dry-run`; mutation requires
`code-butler maintenance prune --apply`. `doctor` reports the same findings under the
`maintenance` category. Database migration backup retention stays under
`retention.migrationBackups`.

## Portable config and local overrides

`.code-butler/config.json` is a sparse, portable project override file. It can
contain retention, privacy redaction rules, deterministic settings, promotion,
retrieval mode, sync sharing policy, and per-source `enabled`, `projectOnly`, and
limit overrides. Machine-wide settings belong in the per-user global
`~/.config/code-butler/config.json`, which is created by `code-butler init` or
`code-butler config global init`. Resolution is built-in defaults, then global
config, then project config.

Existing projects may still contain `.code-butler/config.local.json`. That file
is read as a final compatibility layer and is never rewritten automatically.
Project-specific Git paths remain derived from the project root; Codex and Claude
roots and provider runtime settings belong in the global file.

The legacy migration command remains available for older projects that still keep
machine-specific keys in their shared config:

```bash
code-butler config migrate-local --dry-run --json
code-butler config migrate-local --apply
```

It remains idempotent and does not affect the new global layout. Cloud sync excludes
the global config and legacy `config.local.json` from snapshots and rejects
non-portable incoming project config.

## Git sharing

Code Butler project state lives under `.code-butler/`. Treat that directory as
local runtime state by default. Only commit files that are intentionally useful
to collaborators, such as `.code-butler/.gitignore`,
`.code-butler/project-summary.md`.

Never commit `.code-butler/memory.sqlite`, SQLite WAL/SHM sidecars,
`.code-butler/config.local.json`, sync metadata, imports, logs, staging files, or
migration and recovery backups. If a
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
