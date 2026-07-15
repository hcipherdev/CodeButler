# Fix Legacy Migration Backup Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Code Butler upgrade legacy project databases whose migration ledger is missing without repeatedly failing and creating a backup on every watcher restart.

**Architecture:** Keep migration 1 compatible with the oldest schema it is responsible for by removing lifecycle-only indexes and triggers from its shared base SQL. Create those objects in migration 3 after all lifecycle columns have been added. Preserve existing backup retention and rollback behavior.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, Vitest.

---

### Task 1: Reproduce the legacy migration failure

**Files:**
- Modify: `tests/storage-migrations.test.ts`

- [x] **Step 1: Write the failing regression test**

  Add a fixture with the pre-ledger schema used by the affected project: legacy `memories` and `memory_candidates` tables, no `schema_migrations` rows, and enough data to require a protected backup. Initialize the store and assert that migration completes, lifecycle columns exist, and exactly one migration backup remains.

- [x] **Step 2: Run the focused test to verify it fails**

  Run: `npm test -- tests/storage-migrations.test.ts`

  Expected: FAIL with `no such column: lifecycle_status` from migration 1.

### Task 2: Make migration 1 legacy-safe

**Files:**
- Modify: `src/storage/migrations.ts`

- [x] **Step 1: Move lifecycle-only schema objects out of the v1 base SQL**

  Remove lifecycle indexes and validation triggers from `BASE_SCHEMA`. Add or retain their creation in migration 3 after `ensureColumn` has added `subject_key`, `lifecycle_status`, `valid_from`, `valid_until`, and `status_changed_at`.

- [x] **Step 2: Run the focused migration tests**

  Run: `npm test -- tests/storage-migrations.test.ts`

  Expected: PASS, including the new legacy-without-ledger regression test and existing rollback/retention tests.

### Task 3: Verify the complete change

**Files:**
- Verify: `src/storage/migrations.ts`
- Verify: `tests/storage-migrations.test.ts`

- [x] **Step 1: Run the full test suite**

  Run: `npm test`

  Expected: all Vitest test files pass with zero failures.

- [x] **Step 2: Run type checking**

  Run: `npm run typecheck`

  Expected: TypeScript exits successfully with no diagnostics.

- [x] **Step 3: Probe a copy of the affected project database**

  Run a read-only/copy-based initialization against `/Users/spiel/Documents/pqcrypt_encrypter/.code-butler/memory.sqlite` and confirm the copy upgrades without `lifecycle_status` errors and produces a bounded backup set. Do not mutate the user database during verification.
