# Encrypted Butler sync protocol

User-facing CLI and MCP sync use this protocol for memory bindings marked
`encryptionVersion: 2`. There is no migration from beta memory cloud storage.
Existing encrypted secrets vaults have the preservation and migration path
described below.

## Memory schema compatibility

Database schema 23 adds nullable structured statements to candidate and durable
memories. Snapshots carry these columns automatically. A client that supports an
older database schema rejects a newer snapshot with the existing upgrade-required
response. Schema 24 adds structured memory events, topic revisions, and membership
overrides. Update clients before exchanging schema-24 snapshots. Existing rows keep
NULL statements until explicitly written; no display fallback is backfilled.
Statement conflicts compare both the claim and its structured details.

## Trust and custody

HybridCipher crypto is vendored at revision
`38810069a84f5050b7d1e9798510c89311156ef6`, under its Apache-2.0 license alternative.
Butler owns its account and enrollment protocol, using ChaCha20-Poly1305,
HKDF-SHA256, Ed25519 and hybrid X25519 + ML-KEM-768 key delivery. This does not imply
post-quantum authentication: signatures are Ed25519.

The Rust helper protects device identities, project epoch keys, tokens, registry
history and accepted pins in OS-bound encrypted state. TypeScript receives public
identities and opaque project/epoch references. DPAPI is user-scoped; macOS uses
Keychain. Storage failure is `locked`, without a plaintext-key fallback.

The first device pins a descriptor containing the account/vault IDs, first public
device identity and recovery public keys. Signed vault records carry all active
public devices, project epochs and encrypted key packages. Each record commits to
the preceding record and descriptor. The preceding membership authorizes ordinary
updates; only the descriptor's recovery authority authorizes recovery replacement.
All devices belong to the same owner and have equal management rights.

New enrollment uses a signed `enrollment-v2` request with version **2**. It binds
the complete new-device identity, account, vault, internal request UUID, expiry and
`descriptorHash`. The native helper retains that descriptor checkpoint with the
pending request. The new computer displays one SHA-256 request fingerprint; an
enrolled computer looks it up within the authenticated account and verifies the
complete signed request, fingerprint and descriptor hash against its trusted vault
before approving. The request UUID remains an internal protocol identifier.

The new computer polls authoritative request state and completes enrollment after
approval. Its helper verifies the pinned descriptor, registry chain, exact request
commitment and new-device membership before opening the hybrid Welcome package.
There is no return transfer of a vault fingerprint. Pending requests survive
restart and interrupted responses; an already approved request can finish after
the local deadline. Expiry and cancellation are server-confirmed, and a cancellation
that races with a committed approval finishes the approved enrollment instead of
discarding its trust checkpoint. Legacy version-1 requests retain their separate
descriptor-fingerprint completion path for compatibility.

Signed documents use recursively sorted JSON keys and the fixed prefix
`code-butler/identity/v1` followed by a NUL byte. Their commitments hash the complete
canonical signed document. Public schemas reject unknown fields and bound sizes.

## Memory objects and envelopes

Project memory snapshots use plaintext format **v4**: the core database travels as a
row stream (schema statements, then each shared table's rows in creation order, then
indexes and triggers; no full-text index) cut into content-defined blocks of about
8 KiB (2–64 KiB). Two devices holding the same rows produce the same bytes, so a merge
or a batch of new memories re-sends only the blocks around the changed rows. The
receiver rebuilds SQLite from the stream, verifies it like any snapshot, and rebuilds
the search index locally. Readers accept v3 (a SQLite file in fixed 16/64 KiB blocks),
which global rules and the project catalog still publish; a manifest newer than v4 is
`incompatible-format`, so every device must run a v4 build before any of them
publishes one. Each encrypted
object is `salt[32] || nonce[12] || ciphertext || Poly1305 tag[16]`. HKDF extracts
from the random salt and project epoch key. HKDF info and AEAD associated data are
the JSON array `["code-butler/memory-sync/v1", projectUUID, epoch, purpose]`, where
purpose is `block` or `manifest`. Object addresses are SHA-256 of ciphertext.
Reuse is limited to authenticated blocks from the same epoch. Rotation disables
reuse and re-encrypts every current project head.

The encrypted envelope has version **2**, explicit epoch and membership commitment,
revision, parent commitment, writer public key, sorted ciphertext addresses,
encrypted manifest and signature. Its fixed-order signing representation is in
`encrypted-protocol.ts`. The manifest signature prefixes the same project/epoch
context used above. The encrypted manifest hides file names, plaintext hashes,
SQLite metadata and partition contents.

Every publication also includes a compact signed receipt binding project, vault,
epoch, membership, writer, revision, parent commitment and envelope commitment.
Receipts remain after full-payload pruning. Clients verify contiguous signatures
and authority before accepting the head. Five full snapshots are retained. A known
key cutover requires the current epoch even if a server presents an older signed
head. Accepted revision pins and authenticated cache references survive restarts.

The client decrypts and validates all manifests, block hashes, portable config and
SQLite before applying a snapshot. It composes peer partitions locally and rejects
unauthorized partition transitions when preparing publications. Retained signed
receipts authenticate ancestry when intermediate partition payloads have expired;
this personal-vault model trusts enrolled devices, not the storage provider.

## Account and service boundary

`/v2/auth/*` manages bounded email-code challenges and rotating sessions. Account
possession alone grants initialization for an uninitialized account and enrollment
operations, not existing project reads/publications or device administration.
Full operations require a single-use server nonce and signed request proof binding
account, method, path and body hash. Recovery uses a proof from the offline recovery
authority for ciphertext access and a signed recovery record for activation.

`/v2/vault/*` stores the public descriptor, signed registry and encrypted packages.
Project creation and recovery updates commit together. Revocation/recovery stages
ciphertext first, then one SQLite transaction activates membership, all affected
project heads and new epochs against their expected predecessors. Publications
under stale membership/epochs fail. Exact committed retries are idempotent.
`GET /v2/vault/state?after=<sequence>&hash=<documentHash>` returns `after` and only
the records past that sequence when the caller's last record has that hash, and the
full state otherwise. The registry is append-only, so a device fetches only what it
lacks, and its native helper still verifies the whole chain from the descriptor.

`/v2/projects/*` handles bounded object batches, revision receipts and atomic head
publication. Object addresses, sizes and quota are checked before storage. The
service cannot decrypt or perform semantic merges. Project names stay inside the
encrypted project catalog.
A project's `capabilities` advertise `keepsEnvelope: 1`, under which `publish` may omit
the envelope already sent with `begin-upload` (the lease holds it), and
`binaryObjects: 1`. With binary objects, `transfer-objects` takes an
`application/octet-stream` body: the 16-byte lease id, then frames of a 32-byte address,
a 4-byte big-endian length and the ciphertext. `transfer-read` answers in the same
frames. Both are translated to the JSON `upload` and `read` actions, so the lease,
quota and limit checks (128 objects, 67,500 bytes each) are the same, and the device
proof covers the whole body. Clients use the JSON forms against a service without them.
Retired 1.x endpoints return HTTP 426.

Service and native helper capabilities gate features before their first mutation:
`projectCatalog: 1` for portable identity/catalog support, `deviceEnrollment: 2` for
anchored enrollment, and `accountSecrets: 1` for account-managed secrets. Clients
advertise `x-butler-project-catalog: 1` and, when the native helper supports it,
`x-butler-account-secrets: 1`. Account vaults containing secrets companions reject
incompatible clients, including membership activation/recovery requests, with
HTTP 426 `upgrade-required`. Secrets companions cannot be read or published through
ordinary memory routes.

## Durability and limits

Local protected state atomically journals pins and references to content-addressed
ciphertext caches. The last applied snapshot remains the offline merge ancestor.
Pending uploads retain their exact bytes across retries. Existing project gates,
SQLite validation, local layers and restore recovery mechanisms remain in use.

An offline recovery kit contains the recovery authority and initial trust checkpoint,
encrypted under a generated 256-bit code. Later signed vault records encrypt all
project keys to the recovery public key, so the original kit stays useful. Normal
devices erase recovery private keys after verified export. The server can withhold
updates; neither a new device nor recovery can prove universal global freshness.

Local SQLite and raw-evidence selection are unchanged. Encryption does not remove
previous plaintext cloud backups, encrypt local memory databases, or retroactively
hide content from an enrolled device. Linux enrollment, teams and transparency
infrastructure remain outside this implementation.

## Project secrets folder channel

The optional project-root `secrets/` channel is disabled on each device by default.
Enabling it requires a verified portable project connection and enrolled account;
it does not create or guess a replacement memory project. Each ordinary cloud
project has one deterministic secrets companion resource in the existing account
vault. Its UUID is the first 16 bytes of SHA-256 of
`code-butler/project-secrets`, a NUL byte and the lowercase parent project UUID,
with UUID version 8 and RFC variant bits set. The encrypted catalog records this
association. Companions do not consume an ordinary project slot and are omitted
from normal project listings; their ciphertext still consumes storage quota.

Each companion has an independent random epoch key, revision/receipt chain,
accepted pins and sync journal. The account's signed device membership, hybrid key
packages and recovery authority protect those keys, so enabling secrets requires
no second device approval or project recovery kit. Account revocation and recovery
rotate nonempty secrets heads together with memory and other account resources.
An approved device must still enable secrets locally before downloading files.

Account secrets use `/v2/projects/{parentProjectId}/secrets/*`. The server derives
the companion resource ID, checks the ordinary parent and account membership,
requires the account-secrets capability, and uses the secrets publication and
transfer channel. Ordinary `/v2/projects/{resourceId}/*` memory access to a
companion is rejected. Native key references remain in the account custody state;
its dedicated `secrets-crypto` operation validates the parent/companion relationship
and uses `code-butler/secrets-sync/v1` for blocks, manifests and envelope signatures.
Ordinary memory crypto rejects companion resources. The resource key and distinct
context prevent ciphertext from crossing the memory and secrets channels.

The encrypted manifest contains relative file names, sizes, plaintext hashes and
the mapping from block hashes to ciphertext addresses. The outer envelope exposes
opaque IDs, epoch, membership, writer, revision, ciphertext addresses and sizes.
The server also observes public device labels, the parent/companion relationship,
transfer timing and storage use.
Unchanged ciphertext blocks are reused only within the same epoch. A revocation
re-encrypts the current head under a new key before membership activation.

The local folder stays plaintext so development tools can read it. The server
allows at most one companion for each ordinary parent. The scanner accepts regular
binary files under `secrets/`, with at most 1,000 files, 32 MiB per file and 128 MiB
in total. It rejects links, hard
links, traversal, nonportable names and case collisions. Clients decrypt and verify
the full manifest and every needed block before changing files, compare against
the last applied revision, then use private directories and atomic file replacement. Concurrent edits and
edit-versus-delete require an explicit local or cloud choice. Secret sync state and
ciphertext caches live outside memory snapshots; they never use SQLite restore
journals.

### Preserving existing encrypted secrets vaults

Legacy secrets vaults remain accessible through `/v2/secrets/vaults/{vaultId}` and
`/v2/secrets/projects/{vaultId}` with their original independent membership,
secrets-domain keys, recovery material and signed receipts. They are not silently
assigned by folder name or a Git remote. An existing local binding and verified
account-project link establish the migration target; unknown associations or
missing legacy custody require Account Center review/recovery. Disabled bindings
stay disabled. Enabled legacy bindings can resume migration after account trust
becomes available.

A durable server migration intent binds the legacy vault, ordinary parent,
companion ID and frozen source revision/commitment. Beginning migration requires
an account-device request proof plus a signed authorization from an approved
legacy device or its recovery authority, and compares against the current source
head. Once committed, the source is read-only: legacy uploads, publications and
key rotation fail with `upgrade-required`, including writes through earlier
transfer leases. Exact intent retries are idempotent; competing associations or
changed source heads conflict.

The client decrypts and validates the frozen source with its original custody,
merges unsent local changes against the last applied legacy ancestor, then merges
the result with any existing destination. Divergent files require explicit local
or cloud choices. It publishes newly encrypted companion data, downloads and
validates the accepted destination again, and completes the server intent against
that exact destination pin before updating the encrypted catalog and local binding.
Encrypted journals and caches permit interrupted phases to resume; quota or
network failure leaves source data and pending work intact. Local edits from an
upgraded old device follow the same merge path after another device has migrated.

Cutover preserves the former binding, native custody, encrypted cache and recovery
material as legacy recovery data. It does not erase source ciphertext. Legacy
recovery restores source access for migration; account recovery subsequently
protects the companion. An unpublished legacy setup with no acknowledged cloud
head can move directly to the account companion without inventing source data.

Approved-device compromise, previously downloaded copies and past Git exposure
remain outside the protection of cloud encryption.

Security references: [DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata),
[OWASP single-use token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
