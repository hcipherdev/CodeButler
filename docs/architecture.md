---
layout: false
---
<meta http-equiv="refresh" content="0; url=./architecture.html">

# Code Butler Architecture

The interactive architecture overview is available at [architecture.html](./architecture.html).

Retrieval is local-first: SQLite FTS is the default and always works offline. Optional hybrid mode embeds raw chunks and current promoted memories through one explicitly configured OpenAI-compatible endpoint, then combines lexical and semantic ranks with reciprocal-rank fusion. Endpoint, model, and dimension fingerprints isolate vector indexes. Any disabled, unavailable, privacy-rejected, missing-vector, or incompatible-vector path returns the exact FTS response.

Embedding jobs are persisted as pending, complete, or failed and remain retryable. Evidence sync commits before embedding work begins. Loopback services such as Ollama require no remote privacy opt-in; remote endpoints require `privacy.allowRemoteEmbeddings: true` and always receive secret-redacted text. There is no automatic network fallback.
