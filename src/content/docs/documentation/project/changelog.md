---
title: Changelog
description: Released versions of the current eventsalsa components.
---

This page summarizes released versions of the current `eventsalsa` components. It is intentionally component-oriented so the notes stay aligned with the published libraries rather than the docs site itself.

## eventsalsa/encryption

### v0.0.3

- Added the PostgreSQL system-key rewrap API with `(*postgres.Store).RewrapSystemKeys` for re-encrypting stored DEKs from one system key ID to another in short batches.
- Added dry-run support and progress counters so operators can preview the migration and track `rewrapped`, `remaining`, and batch counts during execution.
- Expanded the README and PostgreSQL test coverage around the recommended rewrap workflow, validation, idempotency, concurrent runs, and historical decryptability after old-key retirement.

### v0.0.2

- Added `cmd/migrate-gen`, a stable CLI entrypoint for generating or printing the PostgreSQL key-store migration.
- Added package helpers in `keystore/postgres/migrations` for rendering and writing migration SQL with schema and table overrides.
- Updated the documentation to cover the CLI-first migration flow and the package-level alternative.

### v0.0.1

- Initial release.

## eventsalsa/worker

### v0.0.2

- Added `cmd/migrate-gen`, a stable CLI entrypoint for generating worker infrastructure migrations.
- Documented both the quick CLI flow and the package-level migration API.

### v0.0.1

- Initial release.

## eventsalsa/store

### v0.0.1

- Initial release.
