# Walkthrough: eventsalsa/encryption v0.0.5 Documentation Rewrite

This pull request completely rewrites the `eventsalsa/encryption` documentation chapter to align with the architectural redesign in **v0.0.5**, and updates the project changelog.

## Key Changes

### 1. Encryption Documentation Chapter (`src/content/docs/documentation/components/encryption.md`)
- **Decoupled In-Memory Engine**: Documented the pure in-memory `envelope.Envelope` cryptographic engine (`envelope.New(keyring, cipher)`), emphasizing zero database, context, or network dependencies during encryption and decryption.
- **Stateless PostgreSQL Keystore**: Documented `postgres.Store` (`postgres.NewStore(env, cfg)`), highlighting explicit connection passing (`*pgxpool.Pool`, `pgx.Tx`, `*pgx.Conn`) and seamless SQL transaction participation.
- **Idiomatic `eventsalsa/store` Integration**: Showcased atomic transaction integration where DEK creation/retrieval and event stream persistence execute within the same `pgx.Tx` via `eventsalsa/store.EventStore.Append`.
- **Unified DEK Lifecycle**: Replaced legacy `pii`, `secret`, and `keymanager` package workflows with direct `postgres.Store` lifecycle methods (`CreateKey`, `RotateKey`, `GetActiveKey`, `GetKey`, `RevokeKeys`, `DestroyKeys`, `ActiveKeyVersion`).
- **GDPR Crypto-Shredding (Article 17)**: Documented hard-deletion via `store.DestroyKeys` combined with `store.Append(ctx, tx, store.Exact(...), ...)` to record lifecycle events while rendering historical immutable payloads permanently and mathematically undecryptable.
- **Secret Rotation & Historical Retention**: Documented versioned key rotation via `store.RotateKey` with soft revocation and historical payload decryption via `store.GetKey`.
- **System Key (KEK) Rewrap**: Documented the standalone administrative utility `postgres.RewrapSystemKeys` for in-place re-encryption of DEKs across system keys in batches with dry-run support.
- **Deterministic Blind Indexing**: Documented HMAC-SHA256 blind indexing via `hash.HMACHasher` for database uniqueness constraints, lookups, and deterministic ID derivation.
- **Memory Hygiene & Sentinel Errors**: Documented `encryption.ZeroBytes` memory scrubbing and root-level sentinel errors (`ErrKeyNotFound`, `ErrKeyExists`, `ErrEncryption`, `ErrDecryption`, `ErrInvalidKeySize`, `ErrKeyRevoked`, `ErrKeyDestroyed`).

### 2. Project Changelog (`src/content/docs/documentation/project/changelog.md`)
- Added release notes for `eventsalsa/encryption` `v0.0.5` detailing breaking changes and package consolidations.

---

## Verification Results

### Automated Validation
- Executed `npm run build` locally; Astro and Starlight built all 8 static routes and generated search indexes successfully with 0 errors or warnings.
