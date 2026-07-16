# Code Butler Release 5 Privacy, Operations, and Maintainability Plan

> **For Codex:** REQUIRED SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before commits or completion claims.

**Goal:** Complete the `v1.0` professional-memory-system release with storage-boundary redaction, auditable privacy administration, verified recovery backups, retention, safe deletion, maintainability extractions, and Node 24 release gates.

**Architecture:** Add one privacy policy and redaction boundary used by every `MemoryStore` write path, then put administrative workflows behind a dedicated privacy service. Schema migration 9 adds a content-free operation log and hashed source-deletion tombstones. Scrub, delete, prune, and non-empty imports operate through a storage-owned atomic maintenance API; a recovery-backup coordinator verifies the backup first, runs integrity checks inside the mutation transaction before commit, verifies again after commit, and retains the backup on any failure. CLI commands call the service, while MCP intentionally exposes no raw export or destructive privacy tools.

**Tech Stack:** TypeScript, Node.js 24 (`node:sqlite`, `node:fs`), SQLite/FTS5, Vitest, existing Code Butler CLI/MCP architecture.

**Branch constraint:** Work directly on the branch active when the conversation started, `main`. Do not create a branch or worktree because the user explicitly requires main-branch work unless they say otherwise.

**Compatibility constraints:** FTS remains the default and offline. Existing databases migrate in place. Existing CLI/MCP names and required parameters remain unchanged. Privacy configuration is additive. Raw export is CLI-only and requires an explicit confirmation flag.

---

## Task 1: Characterize the boundaries before extraction

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `tests/mcp-tools.test.ts`
- Modify: `tests/storage-search.test.ts`
- Modify: `tests/investigator.test.ts`

**Step 1: Write failing or strengthening characterization tests**

Add tests that capture:

- the exact existing top-level CLI help commands and representative error messages;
- the existing MCP tool names and required input compatibility;
- source replacement preserving FTS and relations atomically;
- investigator public behavior for a representative search/read/follow-evidence flow.

These tests are allowed to pass immediately because they characterize existing behavior; do not alter production code in this task.

**Step 2: Run the characterization set**

Run: `npm test -- --run tests/cli.test.ts tests/mcp-tools.test.ts tests/storage-search.test.ts tests/investigator.test.ts`

Expected: PASS and establish a refactor safety net.

**Step 3: Commit**

```bash
git add tests/cli.test.ts tests/mcp-tools.test.ts tests/storage-search.test.ts tests/investigator.test.ts
git commit -m "test: characterize release boundaries"
```

## Task 2: Expand the reusable redaction policy and privacy configuration

**Files:**
- Modify: `src/privacy/redaction.ts`
- Create: `src/privacy/policy.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `.code-butler/config.example.json`
- Modify: `tests/privacy-redaction.test.ts`
- Modify: `tests/config.test.ts`

**Step 1: Write failing redaction and configuration tests**

Cover:

- GitHub, GitLab, Slack, Google, npm, Stripe, generic API-key assignments, bearer tokens, AWS access keys, private keys, and credential URLs;
- configured literal and regular-expression project patterns with stable redaction markers;
- invalid, empty, or unsafe configured regular expressions rejected at config load;
- additive defaults:

```ts
privacy: {
  allowRemoteEmbeddings: false,
  redactionPatterns: []
},
retention: {
  migrationBackups: 5,
  sources: {
    git: { maxAgeDays: null },
    codex: { maxAgeDays: null },
    claude: { maxAgeDays: null },
    manual: { maxAgeDays: null }
  }
}
```

Configured patterns use `{ name, kind: "literal" | "regex", pattern, flags? }`; only `g`, `i`, `m`, `s`, and `u` flags are accepted for regex rules, and matching values are always replaced rather than preserved. Reject empty/zero-width patterns, duplicate/unknown flags, lookarounds, backreferences, nested unbounded quantifiers, invalid names, and patterns longer than 512 characters. Test overlapping rules and redaction idempotence.

**Step 2: Verify RED**

Run: `npm test -- --run tests/privacy-redaction.test.ts tests/config.test.ts`

Expected: FAIL because policy-aware redaction and retention configuration do not exist.

**Step 3: Implement the minimum policy**

- Extend `RedactionType` with the additional common-secret categories and `configured_pattern`.
- Make matches report only type and configured rule name, never the secret value.
- Add `createRedactionPolicy(config)` and `redactWithPolicy(text, policy)`.
- Compile and validate configured patterns once.
- Add `RetentionConfig` and expanded `PrivacyConfig` to `ProjectConfig`, defaults, merge logic, validation, and example configuration.

**Step 4: Verify GREEN and refactor**

Run: `npm test -- --run tests/privacy-redaction.test.ts tests/config.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/privacy/redaction.ts src/privacy/policy.ts src/types.ts src/config.ts .code-butler/config.example.json tests/privacy-redaction.test.ts tests/config.test.ts
git commit -m "feat: add configurable privacy policy"
```

## Task 3: Add schema migration 9 and a content-free operation log

**Files:**
- Modify: `src/storage/migrations.ts`
- Create: `src/operations/types.ts`
- Create: `src/operations/log.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/types.ts`
- Modify: `tests/storage-migrations.test.ts`
- Create: `tests/operation-log.test.ts`

**Step 1: Write failing migration and log tests**

Specify migration 9:

```sql
create table operation_log (
  id text primary key,
  operation_type text not null,
  status text not null check (status in ('started','completed','failed')),
  started_at text not null,
  completed_at text,
  actor text not null check (actor in ('cli','mcp','system')),
  metadata_json text not null default '{}'
)

create table source_tombstones (
  source_type text not null,
  source_id_hash text not null,
  deleted_at text not null,
  operation_id text not null references operation_log(id),
  primary key (source_type, source_id_hash)
)
```

Test that:

- legacy and current fixtures migrate to version 9 without logical-count changes;
- tombstones contain only a source type, SHA-256 source-ID hash, timestamp, and generated operation ID;
- operation metadata rejects keys/values that can contain raw content, secrets, queries, source text, titles, summaries, reasons, paths with credentials, or error stacks;
- allowed metadata is identifier/count/category only;
- operation IDs are generated, actor is an enum, backup names are generated safe basenames, and every column is scanned for secret fixtures after success and failure paths;
- lifecycle changes write a completed log entry in the same transaction;
- later migrations can record a content-free migration operation without breaking the migration transaction or backup behavior.

**Step 2: Verify RED**

Run: `npm test -- --run tests/storage-migrations.test.ts tests/operation-log.test.ts tests/memory-lifecycle-service.test.ts`

Expected: FAIL because migration 9 and the operation API do not exist.

**Step 3: Implement migration and operation APIs**

- Add typed operation categories: `migration`, `lifecycle_change`, `redaction`, `deletion`, `export`, `import`, `retention_prune`, and `recovery`.
- Expose store methods to begin/complete/fail/list operations.
- Expose store methods to create/query hashed source tombstones; never persist the original source ID in this table.
- Sanitize metadata through an allowlist per operation type.
- Record lifecycle transitions inside their existing transaction.
- After schema 9 exists, record later migration completion without putting raw database content in metadata. Do not manufacture history for migrations 1–8.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/storage-migrations.test.ts tests/operation-log.test.ts tests/memory-lifecycle-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/storage/migrations.ts src/operations/types.ts src/operations/log.ts src/storage/store.ts src/types.ts tests/storage-migrations.test.ts tests/operation-log.test.ts tests/memory-lifecycle-service.test.ts
git commit -m "feat: add privacy-safe operation log"
```

## Task 4: Enforce redaction before every new storage write

**Files:**
- Create: `src/storage/content-policy.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/server.ts`
- Modify: `src/cli.ts`
- Modify: `src/sync/service.ts`
- Modify: `src/sources/codex.ts`
- Modify: `src/sources/git.ts`
- Modify: `src/decisions/store.ts`
- Modify: `src/memory/remember.ts`
- Modify: `src/project-summary/service.ts`
- Create: `tests/storage-redaction.test.ts`
- Modify: `tests/sync.test.ts`
- Modify: `tests/project-summary.test.ts`

**Step 1: Write failing end-to-end secret fixtures**

Insert one unique secret fixture through each public write route:

- conversation ingestion;
- Git commit ingestion;
- decision creation/import;
- explicit memory creation and promotion;
- deterministic/LLM candidate creation;
- temporary memory creation;
- source failure recording.

Assert the unique plaintext never appears in any non-SQLite-internal text/blob column, `chunks_fts`, embedding owner text/vector metadata, source-failure messages, operation logs, or regenerated summary input/output. Assert ordinary non-secret text remains searchable.

**Step 2: Verify RED**

Run: `npm test -- --run tests/storage-redaction.test.ts tests/sync.test.ts tests/project-summary.test.ts`

Expected: FAIL because most storage paths currently store unredacted content.

**Step 3: Implement the storage boundary**

- Let `openMemoryStore(rootDir, { privacyPolicy, backupRetention })` accept an immutable policy; the default still applies built-in rules even without config. Production callers load/create config before opening the write-capable store; there is no mutable reconfiguration phase.
- Redact every user-controlled text field and string-containing JSON value in store write methods before SQL execution. Generated UUIDs/hashes and validated ISO timestamps are structural. User-supplied IDs containing a match are replaced by a stable opaque hash before related rows are created; user-supplied paths are redacted consistently before storage. Test IDs, filenames, repository paths, locators, and nested JSON containing secrets.
- Return/use sanitized records from ingestion so extractors, deterministic memory, embeddings, and summary generation cannot receive a secret after storage.
- Create/load config before opening the production write-capable store. If schema bootstrap must happen first, use a read-only/bootstrap store with built-in redaction only, close it, then open the write-capable store once with the immutable configured policy; never reconfigure a live store.
- Never add a raw-storage escape hatch.

**Step 4: Verify GREEN and regressions**

Run: `npm test -- --run tests/storage-redaction.test.ts tests/privacy-redaction.test.ts tests/sync.test.ts tests/project-summary.test.ts tests/embeddings-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/storage/content-policy.ts src/storage/store.ts src/server.ts src/cli.ts src/sync/service.ts src/sources/codex.ts src/sources/git.ts src/decisions/store.ts src/memory/remember.ts src/project-summary/service.ts tests/storage-redaction.test.ts tests/sync.test.ts tests/project-summary.test.ts
git commit -m "feat: redact content at the storage boundary"
```

## Task 5: Build privacy audit and a versioned redacted export/import format

**Files:**
- Create: `src/privacy/export-format.ts`
- Create: `src/privacy/service.ts`
- Create: `src/privacy/backup.ts`
- Create: `src/storage/privacy-maintenance.ts`
- Modify: `src/storage/store.ts`
- Create: `src/cli/privacy.ts`
- Modify: `src/cli.ts`
- Create: `tests/privacy-audit.test.ts`
- Create: `tests/privacy-export.test.ts`
- Modify: `tests/cli.test.ts`

**Step 1: Write failing audit/export/import tests**

Define a JSON export document with `format: "code-butler-privacy-export"`, `version: 1`, export metadata, sources/chunks, commits, decisions, candidates, durable memories with full quality/lifecycle fields, temporary memories, every relation/link table, sync state/cursors, source failures, tombstones, and operation records. Embedding vectors/jobs, FTS tables, and project-summary files are explicitly derived/external and excluded; import rebuilds FTS and embedding jobs. Test that:

- `privacy audit [--json]` reports redaction counts by category and table/field, never matched values;
- `privacy export --output <file>` re-applies redaction even if a legacy DB contains plaintext;
- `privacy export --raw` is rejected unless `--confirm-raw-export` is also present;
- no MCP schema/tool contains raw-export or privacy-delete capability;
- `privacy import --input <file>` recreates every retained table and reconstructs each excluded derived table without exposing removed content; importing into non-empty storage requires explicit confirmation and the recovery workflow;
- export/import logs contain format version/counts only.

**Step 2: Verify RED**

Run: `npm test -- --run tests/privacy-audit.test.ts tests/privacy-export.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: FAIL because the service and commands do not exist.

**Step 3: Implement audit, export, and import**

- Read tables through explicit column lists; never dump `sqlite_master` or arbitrary SQL.
- Audit text and JSON recursively with the configured policy.
- Export redacted by default and write atomically through a same-directory temporary file plus rename.
- Require both `--raw` and `--confirm-raw-export`; raw means the same versioned JSON without a redaction pass, never a SQLite copy, and stays entirely out of MCP.
- Validate import format/version and import into an empty or explicitly confirmed target through a single storage transaction, rebuilding FTS and validating references.
- Add CLI help and stable JSON/human output.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/privacy-audit.test.ts tests/privacy-export.test.ts tests/cli.test.ts tests/mcp-tools.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/privacy/export-format.ts src/privacy/service.ts src/privacy/backup.ts src/storage/privacy-maintenance.ts src/storage/store.ts src/cli/privacy.ts src/cli.ts tests/privacy-audit.test.ts tests/privacy-export.test.ts tests/cli.test.ts tests/mcp-tools.test.ts
git commit -m "feat: add privacy audit and portable export"
```

## Task 6: Implement verified scrub with atomic index repair

**Files:**
- Modify: `src/privacy/service.ts`
- Modify: `src/privacy/backup.ts`
- Modify: `src/storage/privacy-maintenance.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/cli/privacy.ts`
- Create: `tests/privacy-scrub.test.ts`
- Create: `tests/privacy-recovery.test.ts`

**Step 1: Write failing scrub and recovery tests**

Seed a deliberately unsafe legacy database and assert:

- scrub rewrites all user-controlled text fields and JSON strings;
- sources/chunks/FTS/relations/quality state and eligible embedding jobs are reconciled in one transaction;
- changed chunk or current-memory content invalidates only its stale vector and queues the redacted owner;
- the backup itself passes `quick_check` before mutation, and the live database passes `PRAGMA quick_check` plus `foreign_key_check` inside the transaction and again after commit;
- a temporary recovery backup exists before mutation and is removed only after post-commit verification;
- injected mutation or in-transaction verification failures roll back the database and retain the verified backup; a post-commit verification failure triggers restoration from the verified backup before reopening the store. Every failure logs only safe generated identifiers/counts and returns the exact backup path to the CLI;
- `--purge-backups` removes older migration/recovery backups after successful scrub.

**Step 2: Verify RED**

Run: `npm test -- --run tests/privacy-scrub.test.ts tests/privacy-recovery.test.ts tests/storage-embeddings.test.ts`

Expected: FAIL because scrub/recovery do not exist.

**Step 3: Implement scrub and recovery coordination**

- Create the backup with `node:sqlite` backup API using the existing safe child-process pattern, but a distinct `.recovery-...sqlite` name.
- In one transaction, redact all stored user content, rebuild `chunks_fts` and temporary-memory FTS, rebuild source/memory links and quality assessments, remove stale vectors/jobs, and enqueue eligible current owners.
- Run integrity checks before commit, commit, verify again, restore from the already verified backup if that final check fails, then remove the temporary backup only after success.
- On any failure, retain and report the exact backup path; never hide it in a sanitized error.
- Purge old backups only after successful verification and an explicit flag.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/privacy-scrub.test.ts tests/privacy-recovery.test.ts tests/storage-search.test.ts tests/storage-links.test.ts tests/storage-quality.test.ts tests/storage-embeddings.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/privacy/service.ts src/privacy/backup.ts src/storage/privacy-maintenance.ts src/storage/store.ts src/cli/privacy.ts tests/privacy-scrub.test.ts tests/privacy-recovery.test.ts
git commit -m "feat: add verified privacy scrub"
```

## Task 7: Implement evidence-aware source deletion

**Files:**
- Modify: `src/privacy/service.ts`
- Modify: `src/storage/privacy-maintenance.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/sources/codex.ts`
- Modify: `src/sources/git.ts`
- Modify: `src/decisions/store.ts`
- Modify: `src/memory/remember.ts`
- Modify: `src/sync/service.ts`
- Modify: `src/cli/privacy.ts`
- Create: `tests/privacy-delete.test.ts`
- Modify: `tests/memory-lifecycle.test.ts`
- Modify: `tests/storage-transactions.test.ts`

**Step 1: Write failing deletion tests**

Define `privacy delete --source-id <id> --confirm-delete <id> [--purge-backups] [--json]`. Test that deletion:

- rejects missing or mismatched confirmation;
- removes the source, chunks, FTS, source relations, source-owned embeddings, and dependent candidates;
- removes source-owned commit/decision rows, source failures/cursors where provenance matches, temporary memories supported only by the source, and every job/link row that points at removed content;
- removes only matching evidence from durable memories;
- keeps and re-audits a durable memory that still has other evidence;
- retracts a durable memory with no evidence, setting reason `Evidence deleted by privacy operation` and never hard-deleting it;
- removes obsolete conflict-review relations and reruns quality/conflict assessment;
- preserves a content-free completed/failed operation record;
- creates a content-free tombstone keyed by a one-way hash of source type plus original ID, and every ingestion adapter checks it before recreating a deleted source;
- a later full sync/extraction pass does not recreate the source, candidate, or evidence-free durable memory;
- is atomic under injected failure;
- uses the same verified recovery-backup lifecycle as scrub.

**Step 2: Verify RED**

Run: `npm test -- --run tests/privacy-delete.test.ts tests/memory-lifecycle.test.ts tests/storage-transactions.test.ts`

Expected: FAIL because evidence-aware deletion does not exist.

**Step 3: Implement deletion**

- Resolve and validate the source before creating a recovery backup.
- Delete dependent candidates rather than leaving invalid extraction records.
- Recompute durable evidence signatures, links, quality, lifecycle generation, and embedding eligibility.
- Retract evidence-free memories atomically and ensure later sync/extraction cannot reactivate them.
- Store only source type, source ID hash, counts, status, and operation ID in the log/tombstone.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/privacy-delete.test.ts tests/memory-lifecycle.test.ts tests/memory-conflicts.test.ts tests/storage-transactions.test.ts tests/storage-embeddings.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/privacy/service.ts src/storage/privacy-maintenance.ts src/cli/privacy.ts tests/privacy-delete.test.ts tests/memory-lifecycle.test.ts tests/storage-transactions.test.ts
git commit -m "feat: add evidence-aware privacy deletion"
```

## Task 8: Add per-adapter retention pruning and backup retention controls

**Files:**
- Modify: `src/privacy/service.ts`
- Modify: `src/storage/privacy-maintenance.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/cli/privacy.ts`
- Modify: `src/config.ts`
- Create: `tests/privacy-retention.test.ts`
- Modify: `tests/storage-migrations.test.ts`

**Step 1: Write failing retention tests**

Test that:

- each adapter policy (`git`, `codex`, `claude`, `manual`) independently selects expired sources by explicit adapter metadata first, then documented origin fallback; exact-source overrides win, unknown adapters default to indefinite retention, and age uses `sources.created_at` with an inclusive UTC cutoff;
- `null` means retain indefinitely;
- `privacy prune --dry-run` reports exact counts without mutation or backup;
- `privacy prune --apply` uses the deletion workflow per selected source in one recovery-protected operation;
- migration backup retention defaults to the newest five migration backups only, with deterministic mtime/name ordering; recovery backups are excluded, pruning occurs only after migration commit, and configured values are respected;
- explicit `--purge-backups` removes both older migration and recovery backups that could retain explicitly deleted content, reports partial failures, while ordinary migration pruning never silently claims secure deletion.

Retention accepts ordered exact-source overrides `{ sourceId, maxAgeDays }`; an exact override wins over adapter policy. The source ID is used only for selection and is hashed in operation records.

**Step 2: Verify RED**

Run: `npm test -- --run tests/privacy-retention.test.ts tests/storage-migrations.test.ts tests/config.test.ts`

Expected: FAIL because pruning and configured backup retention do not exist.

**Step 3: Implement retention**

- Classify adapters deterministically from explicit metadata, then origin fallback; leave unknown sources indefinitely retained unless an exact override selects them.
- Use `sources.created_at`, UTC inclusive cutoffs, and a supplied clock in tests.
- Share the evidence-aware delete primitive, but create only one recovery backup and one operation record for a prune batch.
- Pass `retention.migrationBackups` into schema initialization in production store creation.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/privacy-retention.test.ts tests/storage-migrations.test.ts tests/config.test.ts tests/privacy-delete.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/privacy/service.ts src/storage/privacy-maintenance.ts src/storage/migrations.ts src/storage/store.ts src/cli/privacy.ts src/config.ts tests/privacy-retention.test.ts tests/storage-migrations.test.ts
git commit -m "feat: add source retention controls"
```

## Task 9: Complete maintainability extractions under characterization tests

**Files:**
- Create: `src/cli/commands/memory.ts`
- Create: `src/cli/commands/sources.ts`
- Create: `src/cli/commands/embeddings.ts`
- Move/modify: `src/cli/privacy.ts` to `src/cli/commands/privacy.ts`
- Modify: `src/cli.ts`
- Create: `src/storage/embedding-store.ts`
- Create: `src/storage/lifecycle-store.ts`
- Create: `src/storage/source-store.ts`
- Modify: `src/storage/store.ts`
- Create: `src/mcp/tool-groups/memory.ts`
- Create: `src/mcp/tool-groups/sources.ts`
- Create: `src/mcp/tool-groups/investigation.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/investigate/history.ts`
- Create: `src/investigate/context-builder.ts`
- Modify: characterization tests from Task 1 only if imports intentionally move; assertions must remain equivalent.

**Step 1: Run characterization tests before extraction**

Run: `npm test -- --run tests/cli.test.ts tests/mcp-tools.test.ts tests/storage-search.test.ts tests/investigator.test.ts`

Expected: PASS.

**Step 2: Extract without behavioral changes**

- Move CLI command implementations behind small typed command modules, leaving parsing entrypoint and usage stable.
- Move source, lifecycle, and embedding SQL implementations into focused storage modules composed by `openMemoryStore`; keep the `MemoryStore` public interface stable.
- Move MCP registrations into tool groups; preserve names, descriptions, schemas, and required fields exactly.
- Move investigation context assembly out of `history.ts`; preserve action ordering, budgets, trace shape, and provider behavior.
- Do not mix new behavior with this task.

**Step 3: Run focused and full refactor verification**

Run: `npm test -- --run tests/cli.test.ts tests/mcp-tools.test.ts tests/storage-search.test.ts tests/storage-embeddings.test.ts tests/memory-lifecycle.test.ts tests/investigator.test.ts tests/investigation.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/cli.ts src/cli src/storage/store.ts src/storage/embedding-store.ts src/storage/lifecycle-store.ts src/storage/source-store.ts src/mcp/tools.ts src/mcp/tool-groups src/investigate/history.ts src/investigate/context-builder.ts tests/cli.test.ts tests/mcp-tools.test.ts tests/storage-search.test.ts tests/investigator.test.ts
git commit -m "refactor: split core memory modules"
```

## Task 10: Add Node 24 release gates and professional documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/retrieval.md`
- Create: `docs/privacy.md`
- Create: `tests/privacy-acceptance.test.ts`
- Modify: `tests/package-public-metadata.test.ts`

**Step 1: Write the cross-feature acceptance test**

Run the unique secret fixture through a fresh database and a migrated legacy fixture. Separate the assertions: fresh writes and all post-migration writes are redacted immediately; pre-existing legacy plaintext is found by audit and never exposed by redacted export; after scrub it no longer appears anywhere. Assert the applicable post-write/post-scrub secret never appears in:

- database text/blob values and FTS;
- vector/job metadata;
- operation logs;
- redacted exports;
- regenerated project summaries.

Then scrub/delete, assert referential integrity and `quick_check`, export/import the redacted database, and verify expected logical counts/lifecycle.

**Step 2: Verify RED if any acceptance behavior remains missing**

Run: `npm test -- --run tests/privacy-acceptance.test.ts tests/package-public-metadata.test.ts`

Expected: FAIL until the release surface and package metadata are complete.

**Step 3: Add release gates and docs**

The Node 24 CI workflow must run separate named gates for:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm run test:public-sync`
6. `npm run docs:build`
7. migration fixtures (a focused script or Vitest target)
8. `npm run eval:retrieval`
9. `npm pack --dry-run`

Pin `actions/setup-node` to Node 24, assert `node --version` is 24.x in CI, and declare/test the compatible Node range in `package.json#engines`.

Document:

- redaction guarantees and configured patterns;
- local versus remote embedding privacy;
- audit/export/import/scrub/delete/prune examples and confirmations;
- recovery and migration backup retention/purge semantics;
- operation-log non-content policy;
- OS-level disk encryption recommendation and a future encrypted storage-adapter seam;
- MCP intentionally excluding raw export and destructive administration.

**Step 4: Verify GREEN**

Run: `npm test -- --run tests/privacy-acceptance.test.ts tests/package-public-metadata.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json README.md docs/operations.md docs/retrieval.md docs/privacy.md tests/privacy-acceptance.test.ts tests/package-public-metadata.test.ts
git commit -m "docs: complete privacy operations release"
```

## Task 11: Final release verification, review, and project memory refresh

**Files:**
- Modify only if verification or review finds a defect.
- Refresh: `.code-butler/project-summary.md` only if normal refresh is allowed by its manual-edit protection; otherwise report the protected state and do not force-overwrite user edits.

**Step 1: Run full release verification with fresh output**

Run, in order:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:public-sync
npm run docs:build
npm run eval:retrieval
npm pack --dry-run
```

Also run the migration fixture and privacy acceptance targets explicitly if they are not separately visible in `npm test` output.

Expected: every command exits 0; retrieval evaluation does not regress the agreed FTS Recall@10 baseline.

**Step 2: Request code review**

Use `superpowers:requesting-code-review`. Review against every Release 5 acceptance criterion, prioritize privacy/data-loss issues, and fix all high/medium findings with TDD.

**Step 3: Re-run affected tests and the full verification suite**

Expected: all fresh checks PASS after review fixes.

**Step 4: Refresh Code Butler memory**

- Run `code-butler project-summary refresh` without `--force`.
- If manual-edit protection refuses, preserve the file and report the reason.
- Sync project memory and record a concise durable Release 5 implementation memory through Code Butler MCP.

**Step 5: Inspect repository state**

Run:

```bash
git status --short --branch
git log --oneline -12
```

Expected: `main`, no unintended untracked/generated files, and only the intended summary metadata change if refresh updated it.

**Step 6: Commit any final verified fixes or generated documentation**

Use a specific message describing the actual final change; do not create an empty completion commit.
