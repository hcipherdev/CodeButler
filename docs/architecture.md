---
layout: false
---
<meta http-equiv="refresh" content="0; url=./architecture.html">

# Code Butler Architecture

The interactive architecture overview is available at [architecture.html](./architecture.html).

Retrieval is local-first: SQLite FTS is the default and always works offline. Optional hybrid mode embeds raw chunks and current promoted memories through one explicitly configured OpenAI-compatible endpoint, then combines lexical and semantic ranks with reciprocal-rank fusion. Endpoint, model, and dimension fingerprints isolate vector indexes. Any disabled, unavailable, privacy-rejected, missing-vector, or incompatible-vector path returns the exact FTS response.

Embedding jobs are persisted as pending, complete, or failed and remain retryable. Evidence sync commits before embedding work begins. Loopback services such as Ollama require no remote privacy opt-in; remote endpoints require `privacy.allowRemoteEmbeddings: true` and always receive secret-redacted text. There is no automatic network fallback.

Project summaries use deterministic Git-tracked context: manifest entrypoints, files linked by current promoted memories, recent commit files, then stable path order. The selector excludes symlinks, binary/ignored/generated/dependency files, environment and credential material, and secret-bearing content. It caps code at 12 files, 20,000 characters each, and 120,000 characters total while hashing full bytes. `.code-butler/project-summary-notes.md` is user-owned. Separate input and output hashes let normal refresh protect manual edits; forced replacement creates a recovery backup when the output is edited or lacks a trusted baseline.

Schema v8 adds deduplicated `source_failures` records with adapter/path/error identity, sanitized messages, first/last occurrence, attempts, and resolution time. Failed parses do not advance cursors, and successful reparsing resolves prior failures. CLI `sources failures`, MCP `list_source_failures`, and Doctor expose repair state without raw source content.
