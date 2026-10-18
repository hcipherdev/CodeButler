# Published memory retrieval

Status: **opt-in**. The published retrieval engine is not the default yet.

The published engine separates interactive reads from ingestion and quality
evaluation. Interactive reads use a completed, device-local SQLite publication;
ingestion, quality evaluation, and publication run in another process. The
canonical memory store remains authoritative.

## How it works

- The canonical store keeps a transactionally maintained mutation journal, so
  the indexer can find changed memories without rescanning everything. Exact
  quotations are resolved by chunk with source ownership checks, and citation
  lookups are batched per request.
- The retrieval index stores normalized memory text, display payloads,
  quality and review state, ordering and filter keys, source metadata, chunks,
  citation previews, semantic vectors, and health aggregates. It lives in the
  device-local project state directory and is excluded from cloud snapshots and
  exports.
- The indexer captures a pinned read snapshot, assesses only changed
  dependencies, and commits incremental publications atomically. Full rebuilds
  are built in separate files and activated only after validation.
- Queries of three or more characters use FTS5 trigram candidates followed by
  the original literal substring match. One- and two-character queries scan
  compact normalized text. Filters apply before pagination, and result ordering
  matches the legacy engine.
- Ordinary retrieval schedules a background refresh. `sync_project_memory`
  waits for ingestion and publication to finish.
- Privacy operations revoke the readable index before they are acknowledged,
  clean derived content, and prevent an older capture from publishing. If the
  indexer fails, the previous completed publication stays available with an
  error and freshness status. A missing or revoked publication reports that it
  is being prepared or unavailable, never an empty result list.

## Measured results

Measured on a Windows laptop (Intel Core i7-8550U, 8 logical processors,
16 GiB RAM) with Node 24, using synthetic fixtures of 1,000, 10,000, and
100,000 memories with ten chunks per memory. The largest fixture has one
million chunks. Times include the first request of each 30-sample run; process
startup and indexing are reported separately.

| Workload | Memories | Median | p95 |
|---|---:|---:|---:|
| First 50 results, empty query | 1,000 | 22.8 ms | 49.2 ms |
| First 50 results, empty query | 10,000 | 14.4 ms | 27.9 ms |
| First 50 results, empty query | 100,000 | 16.8 ms | 26.0 ms |
| Repeated selective query | 100,000 | 8.9 ms | 12.4 ms |
| 30 distinct selective queries | 100,000 | 15.2 ms | 23.8 ms |
| Ten memories, up to five citations each | 100,000 | 11.7 ms | 15.8 ms |
| Two-character query | 100,000 | 132.0 ms | 175.3 ms |

For comparison, the legacy engine's first page at 100,000 memories measured
2,185.5 ms median and 3,392.3 ms p95, roughly 130 times slower.

| Through the MCP protocol, 100,000 memories | Samples | Median | p95 |
|---|---:|---:|---:|
| First 50 memories | 30 | 17.6 ms | 26.1 ms |
| During 1,000 concurrent canonical updates and publication | 1,000 | 25.8 ms | 114.5 ms |

## Known costs and limits

- First index builds took about 10 seconds at 1,000 memories, 2.5 minutes at
  10,000, and 21 minutes at 100,000. These run in the background and are not
  included in the retrieval times above.
- The indexer copies the full canonical database for a consistent capture,
  even when only a few memories changed. Assessment and publication are
  incremental, but capture I/O can still be substantial on large projects.
- Approximate vector indexing and remote embedding latency are outside these
  measurements.

## Try it

Set `CODE_BUTLER_RETRIEVAL_ENGINE=published` in the environment of the MCP
server process, then restart your MCP client. Remove the variable, or set it to
`legacy`, to return to the default engine. The published engine never silently
falls back to scanning the canonical store when its index is unavailable; it
reports that the index is being prepared.
