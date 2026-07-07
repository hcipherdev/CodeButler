# Public Sync

Code Butler is developed in a private repository and published from a separate public checkout.

The private repository is the source of truth. The public repository receives only curated files through the public sync script.

## Repositories

- Private source: `/Users/spiel/Documents/code-butler`
- Public checkout: `/Users/spiel/Documents/CodeButler_public`
- Public GitHub repository: `https://github.com/hcipherdev/CodeButler`

## Rules

- Do not push the private repository or private history to the public remote.
- Do not merge, subtree, cherry-pick, or rewrite private history into the public repository.
- Keep public files explicit and curated.
- Publish npm packages only from the public checkout.

## Sync

Preview the public export:

```bash
node public-sync/sync-public-repo.mjs \
  --source /Users/spiel/Documents/code-butler \
  --target /Users/spiel/Documents/CodeButler_public \
  --dry-run
```

Run the export:

```bash
node public-sync/sync-public-repo.mjs \
  --source /Users/spiel/Documents/code-butler \
  --target /Users/spiel/Documents/CodeButler_public
```

The script refuses to run unless the public checkout is clean and points at the expected public repository.
