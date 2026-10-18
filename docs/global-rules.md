# Global rules

Global rules are Markdown instructions you maintain across projects. Use **Global rules** in the desktop sidebar, or edit the Markdown files directly. Rules start empty, and encrypted sync starts disabled.

Only you save, edit, enable, delete, and resolve rules. Optional desktop AI assistance prepares an unsaved draft when you explicitly request it. Agents receive the read-only `get_applicable_rules` tool, plus `record_rule_attestation`, which writes only verification results (see [Verification results](#verification-results)), never rules. Project ingestion, extraction, promotion, and memory reconciliation cannot use the global rules store. Files remain subject to normal operating-system permissions.

## Add a rule

Choose **Add rule**, then **Describe with AI** or **Enter manually**. AI assistance uses the global reviewer (investigator) provider, model, and credentials, independently of any selected project. Only the description is sent to that provider. Configuration is read from the global `config.json` and `.env`; no project overrides are used.

Explain what the coding assistant should do, select **Generate draft**, and review the wording, suggested settings, and assumptions. Every field is editable. Nothing is saved or synchronized until you select **Save rule**. Regeneration asks before replacing edits. Errors preserve your description and draft; manual entry remains available when AI is unavailable.

New desktop drafts default to **Must**, **All platforms**, **All shells**, and enabled. General guidance uses **Always include**. The AI can choose **When relevant** and prefill actions, file patterns, or keywords for conditional guidance; any matching trigger activates it. Conditional rules need at least one trigger. Choosing Always include clears triggers.

The settings summary is always visible. Open **Adjust settings** to change priority, platforms, shells, inclusion mode, triggers, or **Project filters — optional**. Project filters are files such as `package.json` or `Cargo.toml`: a project containing any listed file matches. Leave them empty for all projects. They do not select a particular named project. AI only narrows platforms, shells, or project filters when your description explicitly requests a restriction, and shows the source excerpt for each restriction.

The form shows **Windows**, **macOS**, and **Linux**, plus common shell choices and custom shell names. Stored identifiers remain unchanged, including `darwin` for macOS. Existing rules and Markdown defaults remain unchanged. Existing-rule editing is manual.

Descriptions are limited to 8 KiB of UTF-8. Each Generate click makes one request, with a 60-second timeout and a 4,096-token output limit. Recognized secrets are rejected before sending and in generated output; describe secret locations instead. There is no background generation or automatic retry.

## Storage and format

Run `code-butler rules path` to find the folder. It is under `CODE_BUTLER_HOME/global/.code-butler/rules`, or the corresponding default global configuration directory. Reading it works offline and does not initialize a database or call a model.

Example file `debug-notes.md`:

```yaml
---
schemaVersion: 1
id: debug-notes
title: "Debug notes"
severity: should
enabled: true
core: false
applies:
  markers: [package.json, Cargo.toml]
  platforms: []
  shells: []
triggers:
  actions: [create_doc]
  paths: ["**/*debug*.md"]
  keywords: [debug, investigation]
---
Save investigation notes under {projectRoot}/docs/debug/.
Include the observed failure, commands run, and the final result.
```

The supported YAML subset has top-level scalars, inline lists, and the two maps shown above, indented by two spaces. Single and double quotes and comments outside quotes are supported. Block lists, anchors, tags, multiline YAML scalars, extra maps, and unknown fields are rejected with diagnostics. The Markdown body may contain multiple lines.

- Required: `schemaVersion: 1`, a title, and a nonempty body. An omitted ID comes from the filename; an explicit ID must match it.
- Defaults: `severity: should`, `enabled: true`, `core: false`, and empty filters/triggers.
- Severities: `must`, `should`, `prefer`. Actions: `write_file`, `create_doc`, `commit`, `read_secrets`, `run_tests`, `add_dependency`.
- IDs use lowercase letters, digits, and hyphens. Desktop creation adds a random suffix. Renaming the title keeps the ID.
- Bodies are limited to 4 KiB and files to 16 KiB of UTF-8. Recognized secrets, unsupported control characters, symlinks, nonportable names, and case-insensitive collisions are rejected.
- `updatedAt` is optional display information. It does not decide conflicts. Reading/indexing never rewrites files.

## Applicability and locations

Filter categories combine with AND; entries within a category combine with OR. Markers are paths relative to the project root. Eligible core rules are always returned. Other rules need an action, path glob, keyword, or explicit ID match. Rules with no triggers remain available by ID or in the catalog. Excluded, disabled, invalid, and conflicted rules do not become guidance.

Shell filters use names such as `powershell`, `bash`, or `cmd`: up to 32 names of 64 ASCII letters, digits, dots, underscores, or hyphens. Unknown environment conditions include the allowed values in the retrieval response.

Path patterns support `*`, `**`, and `?`; other pattern characters are matched literally.

Project `.code-butler/config.json` supports:

```json
{ "globalRules": { "enabled": true, "exclude": ["debug-notes"] } }
```

Defaults enable participation with no exclusions. Current user and project instructions take precedence. Historical project memories remain evidence.

Supply the actual `targetEnvironment`, for example `{ "platform": "win32", "shell": "powershell", "location": "local" }`. Unknown required conditions return `needsVerification`; host defaults do not establish the execution target. Repeat the query with verified conditions before applying conditional guidance.

`{projectRoot}`, `{projectName}`, `{home}`, and `{path:<name>}` resolve only for a confirmed local target. Bind named locations in the global root's `.code-butler/config.local.json`:

```json
{ "rulePaths": { "env": "C:\\Users\\you\\private-config" } }
```

Binding names start with a lowercase letter and contain lowercase letters, digits, or hyphens. Their values must be absolute paths and never sync. Missing or inapplicable locations remain explicit placeholders in `unresolved`. If expansion would exceed the body budget, the complete authored body is preserved and its locations remain unresolved. Store where secrets live, never their contents.

## Retrieval and commands

```text
code-butler rules path
code-butler rules list
code-butler rules show debug-notes
code-butler rules match --action create_doc --path docs/debug/issue.md
code-butler rules match --mode catalog
code-butler rules match --id debug-notes --platform win32 --shell powershell --location local
code-butler rules sync status
code-butler rules sync enable
code-butler rules sync disable
code-butler rules sync now
code-butler rules conflicts
code-butler rules attestations --rule ssh-hardening
code-butler rules attest ssh-hardening --subject ssh-host:SHA256:<fingerprint> --label deploy@web-1
code-butler rules revoke ssh-hardening --subject ssh-host:SHA256:<fingerprint>
```

Agents use `get_applicable_rules({ mode?, actions?, paths?, task?, ids?, targetEnvironment?, subjects?, cursor? })`. Responses contain matching evidence, verified applicability conditions, unresolved conditions/locations, diagnostics, revision, and pagination. Required rules come first, with severity and stable ID ordering within each group. Fetch all `requiredRemaining` pages before acting. A changed request context or rule collection invalidates its cursor; restart the original query. Catalog entries are an index: fetch matching bodies before using them.

Serialized MCP pages have a 12 KiB limit; rule bodies are never truncated. `summarize_project_brief.globalRules` adds a 3 KiB core page and an 8 KiB catalog page with at most 100 entries. Overflow is identified with cursors or IDs. Matching still searches the entire collection. The narrative summary and its content hash are unchanged by this addition.

## Verification results

Some rules check a subject that rarely changes, such as whether a server is hardened. In the desktop rule editor, open **Adjust settings** and set **Repeat this check** to **Once per server** or **Once per project**. Agents then skip the rule for a server or project they already checked, until the result expires or you edit the rule. Choose **Every time** to turn this off. Optionally list words that always trigger a fresh check, such as `sshd_config`.

In the Markdown file the setting is a `verification` map; the editor writes it, including the schema version, for you:

```yaml
schemaVersion: 2
...
verification:
  subject: ssh-host
  ttl: 30d
  recheckOn: [sshd_config, PasswordAuthentication]
```

- `schemaVersion: 2` is required with `verification` and only allowed with it. Rules without it stay at version 1.
- `subject` is `ssh-host` (key: the server host-key fingerprint, `SHA256:` plus 43 base64 characters, for example from `ssh-keygen -l -F <host>`) or `project` (key: derived from `.code-butler-project.json`, or from the folder path when that file is absent).
- `ttl` is how long an agent-recorded result is trusted: 1–365 days, default `30d`.
- `recheckOn` lists task keywords that always serve the full procedure, for example when the task changes the checked configuration.
- AI-drafted rules never include `verification`; only you opt a rule in.

When an agent names subjects in `get_applicable_rules`, a rule whose subjects all have valid results returns a short notice with `bodyOmitted: true` and `verification.status: "verified"` instead of its body. Otherwise the full body is served with `verification.status: "needed"`, the rule's `bodyHash`, and up to 10 `knownSubjects`. Project subjects are matched automatically. Catalog entries show `verifiedSubjects`, the number of valid results.

After running the check, the agent calls `record_rule_attestation` with the rule's `bodyHash`, the subject, `satisfied` or `not_satisfied`, and brief evidence. Agents cannot record exemptions or overwrite yours.

| Outcome | Recorded by | Valid while |
|---|---|---|
| `satisfied` | agent or you | not expired and the rule body is unchanged |
| `not_satisfied` | agent or you | never; the procedure is served |
| `exempt`, `declined` | you only | until revoked; survives body edits |

Your own `satisfied` results last 90 days unless you pass `--ttl`. A reinstalled server has a new host key and so needs a new check. Evidence and labels reject recognized secrets.

Results live beside the rules in `.code-butler/attestations/<rule-id>.json` and sync with them. They merge without conflicts: the latest result per subject wins, and revocations sync as tombstones. Expired results are dropped 30 days after expiry, tombstones after 400 days, and results for deleted rules immediately. Each rule's results are limited to 64 KiB. **Update every synced device first:** older versions reject version 2 rules and attestation files, and their rules sync stops until updated.

## Encrypted sync and conflicts

Sign in and enroll the device before enabling sync. The reserved rules resource uses one vault slot and the existing encryption, recovery, and rotation mechanisms. It is bound to that vault; changing accounts does not silently rebind your rules. Disabling sync keeps local and remote data.

The shared watcher synchronizes enabled rules automatically, including direct file edits. **Sync now** queues through an active watcher, or uses the same ownership lock directly. A failed watcher installation is reported; repair it with `code-butler watch install`. No project ingestion runs against this root.

Sync compares local and remote changes with the last accepted snapshot. Independent changes combine. Divergent same-rule changes and edit/delete changes preserve immutable variants and suspend that rule. Timestamps never select a winner. Invalid content blocks publication and remains available locally for correction.

In the desktop conflict dialog, inspect recorded device/version labels and select a version, deletion, or manually edited Markdown. CLI resolution requires the hashes from `rules conflicts`:

```text
code-butler rules resolve <id> --conflict <conflictId> --expected-state <stateHash> --variant <variantHash-or-deleted>
code-butler rules resolve <id> --conflict <conflictId> --expected-state <stateHash> --file edited-rule.md
```

Stale saves and resolutions are rejected. The desktop keeps your draft so you can review the current version and reapply it. Concurrent different resolutions produce another conflict. Publication/application journals and recovery copies preserve interrupted work; an established binding missing its merge base requires restoring its sync history, rather than assuming a first join.

Generated AGENTS/CLAUDE guidance upgrades only when its historical template or recorded generated hash matches. New guidance uses a versioned managed block. Changed files are backed up; customized files are preserved and reported in project setup status.
