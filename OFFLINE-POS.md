# Phase 3A local cash journal — disabled by default

The authoritative store is SQLite, not browser IndexedDB. The existing Phase 2
hardware API and cloud sale workflow remain available and unchanged.

## Configuration for a future staging terminal
Do not enable this in production before Phase 3B settlement and staging acceptance.
OFFLINE_POS_ENABLED defaults to false (only literal true enables the routes).
When disabled, startup does not import node:sqlite, open a journal, or register offline routes.
Offline mode requires Node 24 LTS or newer; the existing Phase 2 engine requirement is unchanged.

Required values:
- OFFLINE_TERMINAL_ID: registered UUID.
- OFFLINE_TERMINAL_EPOCH: registration incarnation UUID, fenced on replacement.
- OFFLINE_TERMINAL_PRIVATE_JWK_B64: private Ed25519 JWK encoded as base64url JSON.
- OFFLINE_GRANT_PUBLIC_JWK_B64: pinned public-only Ed25519 Admin grant JWK.
- OFFLINE_GRANT_ISSUER: must match Admin.
- OFFLINE_DATA_DIR: absolute local disk path outside OneDrive/UNC/network shares.
- Existing ALLOWED_ORIGIN, PORT, printer and authentication settings remain necessary.

Never put a Supabase service-role credential on the PC. Restrict keys, journal,
WAL/SHM, identity marker and backups with Windows ACLs. POS users should not have
administrative control of the service identity. POSIX mode 0600 alone is not a verified
Windows ACL. Validate BitLocker/disk encryption and backup-key custody before production.
The loopback UI accepts the configured Admin origin for provisioning and its own exact origin
for local operations; it does not add that origin to the legacy hardware endpoints.

## Provisioning and custody
Admin verifies a fresh Ed25519 terminal proof, enrolled key thumbprint, live staff
identity and funded allocation. The signed grant freezes prices, requirements,
resource budget, cashier, terminal/epoch, permissions, service date and expiry.
The default/minimum funding policy is 35% of currently available resource stock,
rounded up after existing reservations; larger allocations may be approved.
Funding and the 35% check occur on the server under stock locks before disconnection.
The terminal cannot create inventory allowances from browser-provided numbers.

The cashier installs an 8–12 digit local PIN while online. Scrypt hashes the PIN with
a random salt. Terminal signatures protect stored grant/PIN metadata.
PIN failure limits and bounded sessions survive process restart; sessions expire at
15 minutes or grant expiry, whichever is earlier. Offline account revocation is bounded
by grant expiry, not instantaneous. Local OS compromise remains outside this trust boundary.

## SQLite schema version 1
- meta: terminal/epoch/key identity, global sequence and clock high-water mark.
- allocations/budgets: immutable allocation fingerprint and atomically consumed resource limits.
- grants: signed immutable grant records and PIN hashes; sessions/login_limits are mutable.
- drafts: one preserved, non-financial preparation per cashier.
- sales: immutable terminal-signed sale and receipt envelope; UUID and sequence are unique.
- outbox: one row per committed sale, initially pending.
- hardware: action identities and independent ready/pending/submitted/rejected/uncertain outcomes.

WAL + synchronous FULL + foreign keys; BEGIN IMMEDIATE guards multi-table writes.
Startup checks schema/integrity/terminal identity and every sale signature.
A process lock excludes another runtime owner. Missing database plus identity marker fails closed.
No automatic reset, archive deletion, journal migration or allocation replenishment exists.
File synchronization cannot guarantee survival of faulty storage hardware or total disk loss.

The commit transaction consumes budget, allocates sequence, stores sale/receipt/signature,
creates the outbox and both original hardware intents, and releases the preparation.
The response acknowledges that local commitment without awaiting Windows spooler work.
Only the original commit schedules drawer then receipt in the shared queue.
Receipt runs even when the drawer fails. The claim is durable before the OS call.
Restart converts pending hardware to uncertain; startup and duplicate delivery never replay it.
Reprints use a fresh explicit receipt-only action UUID. Retrying that UUID deduplicates.
PowerShell/spooler acknowledgement never proves physical paper or drawer movement.

## Browser restart
Open http://127.0.0.1:<PORT>/offline/ directly; all app resources are served locally.
Browser storage contains only session, cashier ID and recovery pointer, not completed cash facts.
After restart, sign in with the PIN. The journal supplies preparation, canonical receipts and history.
Lost commit responses recover by original transaction ID. There is no fallback to cloud/new UUID.
A phone cannot reach the PC's loopback journal. Do not expose it to the LAN as a shortcut.

## Backup/recovery foundations
With the bridge stopped (writer lock must be exclusive), run the compiled maintenance tool:
node dist/offline-maintenance.js backup <new-encrypted-backup-file>
Supply OFFLINE_BACKUP_KEY_B64 as a separate 32-byte base64url key.
The tool uses SQLite VACUUM INTO for a consistent snapshot, encrypts with AES-256-GCM,
synchronizes the encrypted file, and removes the plaintext staging file.
A backup on the same disk is not protection from terminal loss: copy to an independent target
and establish/test a scheduled backup policy, retention and RPO before production enablement.
Keep terminal private-key recovery material separately and securely.

Read-only recovery inspection:
node dist/offline-maintenance.js inspect <encrypted-backup-file> <fresh-staging-file>
This authenticates/decrypts, validates SQLite integrity/schema, reports terminal identity,
sequence and pending count, then removes plaintext staging. It never activates a restored terminal.
Before activation, fence the original terminal, verify financial signatures with its key,
reconcile cloud sequence/UUID high-water marks, and carry forward uncertain hardware claims.
Never restore an old backup over an active journal or run a cloned identity.

## Phase 3B boundary
pending() returns immutable signed envelopes in sequence order. No sync worker or cloud
acknowledgement endpoint exists in 3A. Never delete on dispatch or rerun hardware on sync.
Phase 3B must implement authenticated per-sale acknowledgements, same-identity retries,
backoff, permanent-conflict quarantine, allocation settlement without double stock deduction,
cash/day-close adjustments, and account-disabled-at-sync treatment.
Expired grants must not destroy committed historical records.
Allocation handover and replenishment remain blocked until that reconciliation protocol exists.

Rollback: disable new commitments while preserving pending records, keys and readable schema.
The release ZIP excludes runtime data. Current updater preservation of data is not a backup.
A custom OFFLINE_DATA_DIR must be included explicitly in backup and service operations.
