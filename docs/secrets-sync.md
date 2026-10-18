# Encrypted `secrets/` sync

This desktop feature syncs regular files beneath a project's root `secrets/`
folder. It is off on each computer until you choose **Enable secrets sync**.
Files remain plaintext locally for development tools. The service receives
ciphertext and operational metadata, not readable file names or contents.

## Enable on either computer

1. Sign in and approve the computer through **Account Center → Devices & recovery**.
2. Add the project folder. A verified portable identity reconnects existing cloud
   memory automatically; conflicting connections or content require review.
3. In **Sync & conflicts**, click **Enable secrets sync**. No separate access code,
   vault selection, project recovery file, or secrets device approval is required.

One account device approval covers memory, global rules, and enabled project
secrets. Account recovery covers the new secrets channel. Each project still has
an independent secrets encryption key and a separate file conflict history;
secret values never enter memory snapshots. Enable secrets separately on each
computer. An empty local folder downloads cloud files rather than deleting them.

The project must have a verified connection to the signed-in account. Butler
never guesses a cloud project from its folder name or silently creates replacement
cloud memory. Setup, access, quota, and connection failures appear as statuses;
they are not reported as successful enablement.

## Changes and conflicts

Ordinary edits and deletions synchronize automatically. Competing edits and
edit/delete conflicts require **Keep local** or **Keep cloud** for each affected
file. No unresolved conflict overwrites either version automatically.

**Pause secrets sync** preserves local files, cloud ciphertext, and account device
access. The pause survives logout, login, and restart. Manage approved computers
and recovery in Account Center. Removing a computer rotates memory, rules, and
secrets keys; it cannot erase copies the computer already downloaded.

Butler blocks files already tracked by Git and adds `/secrets/` to `.gitignore`
before syncing. Review and rotate credentials exposed through earlier Git history
or memory capture; encrypting later transfers cannot undo an earlier disclosure.
Limits remain 1,000 files, 32 MiB per file, and 128 MiB per folder. Unsafe paths,
links, hard links, and case collisions are rejected. Secrets use existing account
storage limits and do not consume another project slot.

## Existing secrets vaults

An upgraded computer with legacy secrets access migrates an enabled legacy
binding into its verified account project. Paused bindings migrate when resumed.
Acknowledged source writes are fenced while migration merges and verifies the
destination. Other computers' unsent local edits still enter the normal conflict
flow when upgraded. Interrupted migration resumes instead of creating another
vault or discarding files.

The old encrypted data, native custody, binding, and recovery material are retained.
Keep existing recovery files and codes. Unassociated vaults or unavailable legacy
access require review through Account Center; Butler never infers associations
from names. Older clients cannot publish to a migrating vault or change account
membership after account-managed secrets are present.

See the [protocol notes](encrypted-sync-protocol.md) for the encryption design.

