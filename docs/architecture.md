# Code Butler Architecture

Retrieval is local-first: SQLite FTS is the default and always works offline. Optional hybrid mode embeds raw chunks and current promoted memories through one explicitly configured OpenAI-compatible endpoint, then combines lexical and semantic ranks with reciprocal-rank fusion. Endpoint, model, and dimension fingerprints isolate vector indexes. Any disabled, unavailable, privacy-rejected, missing-vector, or incompatible-vector path returns the exact FTS response.

Embedding jobs are persisted as pending, complete, or failed and remain retryable. Evidence sync commits before embedding work begins. Loopback services such as Ollama require no remote privacy opt-in; remote endpoints require `privacy.allowRemoteEmbeddings: true` and always receive secret-redacted text. There is no automatic network fallback.

Project summaries use deterministic Git-tracked context: manifest entrypoints, files linked by current promoted memories, recent commit files, then stable path order. The selector excludes symlinks, binary/ignored/generated/dependency files, environment and credential material, and secret-bearing content. It caps code at 12 files, 20,000 characters each, and 120,000 characters total while hashing full bytes. `.code-butler/project-summary-notes.md` is user-owned. Separate input and output hashes let normal refresh protect manual edits; forced replacement creates a recovery backup when the output is edited or lacks a trusted baseline.

Schema v8 adds deduplicated `source_failures` records with adapter/path/error identity, sanitized messages, first/last occurrence, attempts, and resolution time. Failed parses do not advance cursors, and successful reparsing resolves prior failures. CLI `sources failures`, MCP `list_source_failures`, and Doctor expose repair state without raw source content.


## Memory scope

Memories carry project-wide, conditional, or unspecified applicability separately
from generation origin. Retrieval labels OS, architecture, and shell mismatches
without filtering history. The `update_memory_scope` tool corrects scope atomically
with linked candidate/durable records. See [memory scope and applicability](./privacy.md#memory-scope-and-applicability).

## Memory layers

A memory's *layer* is a separate axis from its scope: scope says where a memory's
advice applies, layer says where the memory lives. Promoted durable memories default
to the shared `core` layer; unpromoted durable candidates default to the current
branch/device layer when the configured Git repo is off the default branch. Temporary
working context defaults to `device:<id>` and stays on the machine that recorded it.
`find_memories` reports each memory's layer and
accepts an optional `layer` filter (`core`, `device`, `branch`, or `all`, defaulting
to all). `update_memory_layer` moves existing memories between layers atomically
with linked candidate/durable records. `suggest_memory_layer_promotions` is a
read-only review pass for non-core durable memories that may be ready for `core`.
Branch merge triage adds a reviewed path for branch layers:
`suggest_branch_memory_triage` classifies branch memories as current, merged, stale,
active, or unknown, and `resolve_branch_memory_triage` explicitly promotes,
discards, or retains them. Sync does not auto-promote branch memories.

## Memory review and trust

Schema v19 stores append-only Verify, Correct, and Discard resolutions. Each review is
bound to a fingerprint of memory content, evidence availability, conflicts, and the
latest related-file commits, so changed context reopens review rather than silently
reusing old human judgment. Human verification does not change extraction confidence
or promote a candidate. Core review records travel with core sync; non-core records
travel with their owning layer partition.

Memory results distinguish human verification, evidence-backed status, review needs,
and quarantine from numeric extraction confidence. Config-key and documentation-heading
heuristics no longer emit durable memories. Existing rows from those heuristics remain
auditable in quarantine and can be individually verified.
