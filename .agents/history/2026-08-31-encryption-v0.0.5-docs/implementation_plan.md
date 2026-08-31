# Implementation Plan: eventsalsa/encryption v0.0.5 Documentation Rewrite

## Overview
Rewrite the documentation chapter for `eventsalsa/encryption` and update the changelog to reflect `v0.0.5` without any legacy or backward compatibility notes from `v0.0.4`.

## Scope of Work

### 1. Research and Analysis
- Compare `v0.0.4` and `v0.0.5` changes in `eventsalsa/encryption`.
- Identify key architectural shifts:
  - Decoupled in-memory cryptographic engine (`envelope.Envelope`).
  - Stateless PostgreSQL key store (`postgres.Store`) with explicit connection passing (`*pgxpool.Pool`, `pgx.Tx`, `*pgx.Conn`).
  - Unified DEK lifecycle methods directly in `postgres.Store`.
  - Standalone `postgres.RewrapSystemKeys` administrative function.
  - Removal of `pii`, `secret`, `keymanager`, and `encerr` legacy packages.
  - Root package sentinel errors and `ZeroBytes`.

### 2. Documentation Chapter Rewrite (`src/content/docs/documentation/components/encryption.md`)
- Author comprehensive, clean documentation representing only `v0.0.5`:
  - Two-tier key hierarchy (KEK → DEK → data).
  - Package overview.
  - Migration generation via `cmd/migrate-gen` and programmatic helpers.
  - System keyring setup (in-memory and file-based).
  - Basic setup and execution flow.
  - Transaction-bound key creation and event persistence.
  - Domain modeling with custom value objects.
  - Projection and read model decryption with idempotent position guards.
  - GDPR Article 17 crypto-shredding via `store.DestroyKeys`.
  - Secret rotation via `store.RotateKey` and historical audit decryption via `store.GetKey`.
  - System key rewrapping via `postgres.RewrapSystemKeys`.
  - Deterministic HMAC-SHA256 blind indexing via `hash.HMACHasher`.
  - Pluggable ciphers (`cipher.Cipher`), memory hygiene (`encryption.ZeroBytes`), and sentinel errors.

### 3. Changelog Update (`src/content/docs/documentation/project/changelog.md`)
- Add `### v0.0.5` section to `## eventsalsa/encryption` detailing breaking changes and architectural refinements.

### 4. Validation & Verification
- Run `npm run build` to ensure all Astro and Starlight documentation builds cleanly with zero errors or warnings.
- Ensure `eventsalsa/encryption` repository remains untouched.

### 5. Git & PR
- Commit changes using Conventional Commits with extended descriptions and multiple `-m` flags.
- Push branch `docs/encryption-v0.0.5-update`.
- Open Pull Request via GitHub MCP server.
