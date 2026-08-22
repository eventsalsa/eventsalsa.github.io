---
title: Changelog
description: Released versions of the current eventsalsa components.
---

This page summarizes released versions of the current `eventsalsa` components. It is intentionally component-oriented so the notes stay aligned with the published libraries rather than the docs site itself.

## eventsalsa/store

### v0.2.0

- **Breaking Changes**:
  - Removed `Consumer` and `ScopedConsumer` interfaces from the store package (`github.com/eventsalsa/store/consumer`).

### v0.1.0

- **Breaking Changes**:
  - Replaced `Aggregate` terminology with `Stream` across all core types (`Event.StreamType`, `Event.StreamID`, `PersistedEvent.StreamVersion`, `Stream`), stream reader interfaces (`StreamReader.ReadStream`), configuration (`postgres.WithStreamHeadsTable`), migration tables (`stream_heads`), and CLI tools (`eventmap-gen`, `migrate-gen`).
- **Features**:
  - Added declarative PostgreSQL range partitioning on `global_position` for massive event logs, supporting native pre-allocated partitions and dynamic management with `pg_partman` (via `pg_cron`, background worker `bgw`, or external scheduler).
- **Improvements**:
  - Introduced authoritative `stream_heads` atomic optimistic concurrency control engine with transaction row-level locking.
  - Migrated integration test suite to `testcontainers-go`.
  - Upgraded to `github.com/jackc/pgx/v5` v5.10.0.

### v0.0.4

- **Bug Fixes**:
  - Fixed non-deterministic switch-case generation in `eventmap-gen` and formatted generated code with standard `go/format`.
  - Configured automated releases with Release Please.

### v0.0.3

- Fixed JSONB parameter binding compatibility when using pgx's simple protocol mode, ensuring metadata maps correctly under PgBouncer transaction pooling.

### v0.0.2

- Migrated PostgreSQL event store implementation and interface parameters to native `pgx/v5`, removing the `database/sql` dependency.

### v0.0.1

- Initial release.

## eventsalsa/projector

### v0.4.0

- **Features**:
  - Refined lifecycle coordination for seamless `golang.org/x/sync/errgroup` integration: `(*Daemon).Start(ctx)` returns `nil` on graceful context cancellation and non-nil on fatal faults.
  - Added configurable `WithShutdownTimeout(d)` for in-flight batch draining during graceful daemon shutdown before forced cancellation.
  - Introduced `(*Daemon).IsRunning()` and `(*Daemon).IsLeader()` state inspection methods for liveness, readiness, and monitoring probes.

### v0.3.0

- **Features**:
  - Introduced pluggable runtime `Observer` interface (`OnBatchProcessed`, `OnHeartbeat`, `OnGapDetected`, `OnGapSkipped`, `OnRebalance`) for real-time telemetry, gap tracking, and Prometheus metrics emission without out-of-band database polling.
  - Added telemetry data structures (`BatchStats`, `DaemonStats`, `GapStats`) and utility wrappers (`NoopObserver`, `MultiObserver`).

### v0.2.0

- **Features**:
  - Introduced canonical `Projection` interface (`Name() string`, `Handle(ctx context.Context, tx pgx.Tx, event store.PersistedEvent) error`).
  - Added dynamic projection stream and event filtering decorators (`FilterStreamTypes`, `FilterEventTypes`).
  - Upgraded core dependency to `github.com/eventsalsa/store` v0.2.0.

### v0.1.0

- **Breaking Changes**:
  - Replaced `Aggregate` terminology with `Stream` across all projection contracts, event filtering, and persisted event structures.
  - Upgraded core dependency to `github.com/eventsalsa/store` v0.1.0.
- **Improvements**:
  - Migrated integration test suites to `testcontainers-go` for automated ephemeral PostgreSQL container provisioning.
  - Configured automated release management and versioning with Release Please.

### v0.0.3

- Migrated PostgreSQL projector database operations to native `pgx/v5`, removing the `database/sql` coupling.
- Introduced table-based lease leader election (`projector.LeaderStrategyLease`) to support deployments running behind PgBouncer in transaction pooling mode.
- Added a cascading delete constraint to the leader election table.
- Added driver-agnostic database serialization failure detection.
- Expanded integration test suite to cover partitioning, reconnection, and leader demotion scenarios.

### v0.0.2

- Added `cmd/migrate-gen`, a stable CLI entrypoint for generating projector infrastructure migrations.
- Documented both the quick CLI flow and the package-level migration API.

### v0.0.1

- Initial release.

## eventsalsa/encryption

### v0.0.4

- Migrated PostgreSQL keystore implementation and transactional propagation helpers (`keystore.WithTx`) to native `pgx/v5`, removing dependencies on `database/sql`.

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
