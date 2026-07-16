# Retrieval

Full-text search is the default and always works offline:

```json
{
  "retrieval": { "mode": "fts", "rrfK": 60 }
}
```

Hybrid mode combines FTS and cosine-ranked vectors through reciprocal-rank fusion. Embeddings are created only for source chunks and current durable memories. Candidates, temporary memories, superseded memories, and retracted memories are excluded.

OpenAI-compatible `/embeddings` providers may be loopback services such as Ollama or explicitly configured remote services. Remote endpoints require `privacy.allowRemoteEmbeddings: true`, and outbound text is always redacted. Provider endpoint, model, and dimension form an isolated fingerprint; vectors with different fingerprints never participate in one ranking operation.

Embedding failures are retryable and never roll back source sync or disable FTS:

```bash
code-butler embeddings build
code-butler embeddings status --json
npm run eval:retrieval
```
