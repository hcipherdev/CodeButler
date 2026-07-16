# Privacy

Code Butler is local-first. Full-text search works offline, embeddings are optional, and destructive privacy administration is available only through the CLI.

## Storage redaction

New source content, chunks, memories, decisions, failures, JSON values, file paths, and temporary context pass through the same redaction policy before storage. Built-in rules cover common API keys, bearer tokens, AWS credentials, private keys, credential URLs, and major provider token formats.

Project-specific rules can be added in `.code-butler/config.json`:

```json
{
  "privacy": {
    "allowRemoteEmbeddings": false,
    "redactionPatterns": [
      {
        "name": "internal token",
        "kind": "regex",
        "pattern": "INTERNAL-[A-Za-z0-9]+"
      }
    ]
  }
}
```

Unsafe regular expressions are rejected when configuration loads. Code Butler never offers an unredacted remote-embedding mode.

## Administrative commands

```bash
code-butler privacy audit --json
code-butler privacy export --output ./memory-export.json
code-butler privacy import --input ./memory-export.json
code-butler privacy scrub
code-butler privacy delete --source-id <id> --confirm-delete <id>
code-butler privacy prune --dry-run
code-butler privacy prune --apply
```

Exports are redacted by default. A raw JSON export requires both `--raw` and `--confirm-raw-export`; raw export and destructive privacy commands are intentionally unavailable through MCP.

Scrub, confirmed non-empty import, delete, and applied retention pruning use verified SQLite recovery backups. They verify `quick_check` and foreign keys, retain the exact backup on failure, and remove the temporary recovery copy only after success. Use `--purge-backups` after scrub, delete, or prune when older database backups may still contain content you explicitly removed.

The operation log records migrations, lifecycle changes, redaction, deletion, export/import, pruning, and recovery using generated identifiers, hashes, categories, and counts. It does not record search queries or raw content.

Code Butler does not encrypt the SQLite file itself. Use operating-system full-disk encryption and appropriate filesystem permissions. The storage boundary remains isolated so a future encrypted backend can be added without changing the public memory interfaces.
