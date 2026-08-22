---
title: Projector
description: Run projections asynchronously with eventsalsa/projector.
---

`eventsalsa/projector` is the asynchronous projection engine in the eventsalsa bundle. It builds on `eventsalsa/store` and provides a horizontally scalable, PostgreSQL-native runtime for distributed projections.

The projector is not a second event store. It is the runtime that reads the store's global log safely, manages checkpoints, and drives projections forward without requiring Redis, ZooKeeper, or an external message broker just to coordinate which instance handles what.

At a practical level, the component covers:

- running projections outside the request path for eventual consistency
- scaling projections deterministically across multiple projector instances
- atomic checkpoint management within projection transactions
- gap-aware frontier progression under concurrent out-of-order sequence commits
- pluggable real-time telemetry and metrics through a lightweight `Observer` interface

## Install the projector

Add the module to your project:

```bash
go get github.com/eventsalsa/projector
```

In a typical deployment, the projector runs alongside `github.com/eventsalsa/store` and connects to the same PostgreSQL database. That means your database requires:

- the event-store tables from `eventsalsa/store` (`events`, `stream_heads`)
- the projector infrastructure tables from `eventsalsa/projector`

## Generate the projector migration SQL

The quickest way to scaffold the infrastructure tables is the `migrate-gen` CLI:

```bash
go run github.com/eventsalsa/projector/cmd/migrate-gen \
  -output ./db/migrations \
  -filename 002_projector_tables.sql
```

That command generates a SQL migration containing the metadata tables required by the daemon. Check that file into your migration system and apply it before starting the daemon.

If you need custom table names, the CLI provides dedicated flags:

```bash
go run github.com/eventsalsa/projector/cmd/migrate-gen \
  -output ./db/migrations \
  -projector-instances-table infra.projector_instances \
  -projection-assignments-table infra.projection_assignments \
  -projection-checkpoints-table infra.projection_checkpoints \
  -projection-gap-skips-table infra.projection_gap_skips \
  -projector-leader-leases-table infra.projector_leader_leases
```

You can also invoke the `migrations` package directly from your Go tooling:

```go
package main

import (
	"log"

	"github.com/eventsalsa/projector/migrations"
)

func main() {
	config := migrations.DefaultConfig()
	config.OutputFolder = "./db/migrations"
	config.OutputFilename = "002_projector_tables.sql"
	config.ProjectorInstancesTable = "infra.projector_instances"
	config.ProjectionAssignmentsTable = "infra.projection_assignments"
	config.ProjectionCheckpointsTable = "infra.projection_checkpoints"
	config.ProjectionGapSkipsTable = "infra.projection_gap_skips"
	config.ProjectorLeaderLeasesTable = "infra.projector_leader_leases"

	if err := migrations.GeneratePostgres(&config); err != nil {
		log.Fatal(err)
	}
}
```

The generated migration creates five tables:

- `projector_instances`: tracks active projector instances and heartbeats
- `projection_assignments`: maps projections to live instances
- `projection_checkpoints`: stores each projection's last processed global position
- `projection_gap_skips`: durable audit trail for stale-gap safe-harbor advancements
- `projector_leader_leases`: manages active leader election leases

These tables form the projector's control plane. They hold coordination state, ownership, checkpoints, and gap audit history rather than business domain data. When table names specify PostgreSQL schema prefixes, matching `CREATE SCHEMA IF NOT EXISTS ...` statements are emitted automatically.

## Minimum example

A minimal projector deployment needs three pieces:

1. a database connection pool (`*pgxpool.Pool`)
2. an event store reader implementation (`github.com/eventsalsa/store/postgres`)
3. one or more projections implementing `projector.Projection`

Here is a projection handler. Projections implement `Name()` and `Handle(...)`:

```go
type OrderOverviewProjection struct{}

func (p *OrderOverviewProjection) Name() string {
	return "order_overview_v1"
}

func (p *OrderOverviewProjection) Handle(ctx context.Context, tx pgx.Tx, event store.PersistedEvent) error {
	_ = ctx
	_ = tx
	_ = event
	return nil
}
```

To scope the projection to specific stream types, decorate it with `projector.FilterStreamTypes(...)`:

```go
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/eventsalsa/projector"
	storepostgres "github.com/eventsalsa/store/postgres"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	connStr := "postgres://postgres:postgres@localhost:5432/eventsalsa?sslmode=disable"

	db, err := pgxpool.New(ctx, connStr)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	eventStore := storepostgres.NewStore(storepostgres.DefaultStoreConfig())

	projections := []projector.Projection{
		projector.FilterStreamTypes(&OrderOverviewProjection{}, "Order"),
	}

	daemon := projector.New(
		db,
		eventStore,
		projections,
		projector.WithBatchSize(100),
		projector.WithPollInterval(500*time.Millisecond),
	)

	if err := daemon.Start(ctx); err != nil {
		log.Fatal(err)
	}
}
```

`(*projector.Daemon).Start(...)` blocks until the context is canceled or a fatal internal error occurs. This makes the daemon the main entrypoint for a background projector daemon binary or service.

## Full configuration

The projector daemon uses functional options. Most systems run well with the default configuration, but the runtime exposes full control over batching, polling intervals, timeouts, and table names:

```go
daemon := projector.New(
	db,
	eventStore,
	projections,
	projector.WithBatchSize(200),
	projector.WithBatchPause(100*time.Millisecond),
	projector.WithBatchTimeout(20*time.Second),
	projector.WithMaxConsecutiveFailures(5),
	projector.WithPollInterval(500*time.Millisecond),
	projector.WithMaxPollInterval(10*time.Second),
	projector.WithDispatcherInterval(200*time.Millisecond),
	projector.WithHeartbeatInterval(5*time.Second),
	projector.WithHeartbeatTimeout(30*time.Second),
	projector.WithRebalanceInterval(5*time.Second),
	projector.WithStaleGapThreshold(30*time.Second),
	projector.WithStaleGapHarborLag(8),
	projector.WithDispatcherStrategy(projector.DispatcherStrategyPoll),
	projector.WithLeaderStrategy(projector.LeaderStrategyLease),
	projector.WithProjectorLeaderLeasesTable("projector_leader_leases"),
	projector.WithObserver(observer),
	projector.WithLogger(logger),
)
```

| Option | Default | Description |
| --- | --- | --- |
| `WithBatchSize(n)` | `100` | Maximum number of events fetched and processed per batch window. |
| `WithBatchPause(d)` | `200ms` | Pause between consecutive catch-up batches when a full window was read. |
| `WithBatchTimeout(d)` | `30s` | Maximum duration for a single batch processing transaction. |
| `WithMaxConsecutiveFailures(n)` | `5` | Fatal threshold for consecutive batch errors before triggering shutdown. |
| `WithPollInterval(d)` | `1s` | Base interval for projection polling loops. |
| `WithMaxPollInterval(d)` | `30s` | Maximum interval used during adaptive exponential backoff. |
| `WithDispatcherInterval(d)` | `200ms` | Polling interval used by the wakeup dispatcher. |
| `WithHeartbeatInterval(d)` | `5s` | How frequently an instance refreshes its liveness heartbeat. |
| `WithHeartbeatTimeout(d)` | `30s` | Age after which an instance is considered dead by the leader. |
| `WithRebalanceInterval(d)` | `5s` | How frequently the leader evaluates projection assignment rebalancing. |
| `WithStaleGapThreshold(d)` | `30s` | Duration to wait on a missing sequence position before safe-harbor skipping. |
| `WithStaleGapHarborLag(n)` | `8` | Distance behind visible head maintained during stale-gap advancement. |
| `WithDispatcherStrategy(strategy)` | `poll` | Wakeup strategy: `DispatcherStrategyPoll` or `DispatcherStrategyNotify`. |
| `WithNotifyConnectionString(connStr)` | empty | Dedicated PostgreSQL connection string for `LISTEN`/`NOTIFY`. |
| `WithNotifyChannel(channel)` | empty | Notification channel for notify-based dispatching. |
| `WithLeaderStrategy(strategy)` | `advisory` | Leader coordination: `LeaderStrategyAdvisory` or `LeaderStrategyLease`. |
| `WithProjectorLeaderLeasesTable(name)` | `projector_leader_leases` | Lease table name for lease-based leader election. |
| `WithProjectorInstancesTable(name)` | `projector_instances` | Instance registration table name. |
| `WithProjectionAssignmentsTable(name)` | `projection_assignments` | Projection assignment table name. |
| `WithProjectionCheckpointsTable(name)` | `projection_checkpoints` | Checkpoint tracking table name. |
| `WithProjectionGapSkipsTable(name)` | `projection_gap_skips` | Stale-gap audit table name. |
| `WithObserver(observer)` | `nil` | Pluggable telemetry and lifecycle listener. |
| `WithLogger(logger)` | `store.NoOpLogger{}` | Structured logger integration. |

## Batching and Transactions

The projector processes events in batches within database transactions. This ensures high catch-up throughput and consistency.

### `BatchSize`

`WithBatchSize(...)` controls how many rows the daemon reads in each batch window.

- **Smaller batches**: shorter transaction durations, lower lock contention, and lower retry overhead on failures.
- **Larger batches**: higher throughput when catching up on backlogs and fewer round trips to PostgreSQL.

### Atomic Checkpointing

For SQL-backed read models, the daemon supplies the active `pgx.Tx` transaction to `Handle(ctx, tx, event)`. The projection handler updates the read model tables using this transaction, and the daemon writes the updated checkpoint inside the exact same transaction before committing.

This provides atomic consistency: either both the read model mutations and the checkpoint update succeed and commit together, or both roll back on failure.

:::tip
Projections must **never** call `Commit()` or `Rollback()` on the provided `tx`. The daemon manages the transaction lifecycle. For non-SQL projections (such as Elasticsearch or Redis), ignore the `tx` parameter and manage external client connections independently.
:::

## Stream and Event Filtering

Projections can be decorated to process only specific events:

- **`FilterStreamTypes`**: filters events by `StreamType` (e.g. `"Order"`, `"Payment"`).
- **`FilterEventTypes`**: filters events by `EventType` (e.g. `"OrderPlaced"`, `"OrderConfirmed"`).

```go
projections := []projector.Projection{
	projector.FilterStreamTypes(&OrderOverviewProjection{}, "Order"),
	projector.FilterEventTypes(&AuditLogProjection{}, "UserRegistered", "PasswordReset"),
}
```

Events that do not match the filter are skipped cleanly in memory without invoking `Handle`, allowing the projection checkpoint to advance safely past non-matching events.

## Observability and telemetry

The projector daemon exposes internal runtime events and metrics via a pluggable `Observer` interface without executing any extra out-of-band database polling queries:

```go
type Observer interface {
	OnBatchProcessed(ctx context.Context, stats BatchStats)
	OnHeartbeat(ctx context.Context, stats DaemonStats)
	OnGapDetected(ctx context.Context, stats GapStats)
	OnGapSkipped(ctx context.Context, stats GapStats)
	OnRebalance(ctx context.Context, assignments map[string]uuid.UUID)
}
```

### Telemetry data structures

- **`BatchStats`**: contains batch execution latency (`Duration`), global checkpoint positions (`StartPosition`, `LastPosition`, `HeadPosition`), calculated event lag (`Lag = max(0, HeadPosition - LastPosition)`), throughput counts (`EventsRead`, `EventsHandled`), safe-harbor stale skip indicator (`StaleSkipped`), and error status (`Error`).
- **`DaemonStats`**: contains instance UUID (`InstanceID`) and leadership status (`IsLeader`).
- **`GapStats`**: contains missing sequence coordinate (`GapPosition`), visible stream head (`HighestVisible`), and elapsed duration (`StaleFor`).

### Convenience utilities

- **`NoopObserver`**: empty struct implementing all `Observer` methods. Embed it into your struct to implement only the callbacks you need.
- **`MultiObserver(observers ...Observer) Observer`**: combines multiple observers (e.g. Prometheus + OpenTelemetry + structured logger) into a single composite listener, automatically stripping `nil` entries and flattening nested multi-observers.

### Prometheus metrics recipe

```go
package main

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/eventsalsa/projector"
)

type PrometheusObserver struct {
	projector.NoopObserver
	batchDuration *prometheus.HistogramVec
	lagGauge      *prometheus.GaugeVec
	eventsHandled *prometheus.CounterVec
	checkpointPos *prometheus.GaugeVec
}

func NewPrometheusObserver() *PrometheusObserver {
	return &PrometheusObserver{
		batchDuration: promauto.NewHistogramVec(prometheus.HistogramOpts{
			Name: "projector_batch_duration_seconds",
			Help: "Duration of projection batch processing in seconds.",
		}, []string{"projection", "status"}),
		lagGauge: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "projector_lag_events",
			Help: "Current projection lag in global events behind event store head.",
		}, []string{"projection"}),
		checkpointPos: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "projector_checkpoint_position",
			Help: "Current global checkpoint position reached by projection.",
		}, []string{"projection"}),
		eventsHandled: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "projector_events_handled_total",
			Help: "Total number of events handled by projection.",
		}, []string{"projection"}),
	}
}

func (p *PrometheusObserver) OnBatchProcessed(_ context.Context, stats projector.BatchStats) {
	status := "success"
	if stats.Error != nil {
		status = "error"
	}

	p.batchDuration.WithLabelValues(stats.ProjectionName, status).Observe(stats.Duration.Seconds())
	p.lagGauge.WithLabelValues(stats.ProjectionName).Set(float64(stats.Lag))
	p.checkpointPos.WithLabelValues(stats.ProjectionName).Set(float64(stats.LastPosition))
	p.eventsHandled.WithLabelValues(stats.ProjectionName).Add(float64(stats.EventsHandled))
}
```

## Dispatcher strategy

The dispatcher detects when new events are committed so projection loops wake up immediately without waiting for their idle polling interval.

### Poll dispatcher

`projector.DispatcherStrategyPoll` is the default. It periodically inspects the highest global position and wakes active projection loops whenever the position advances.

This is recommended for:
- standard deployments and microservices
- deployments running behind connection poolers like PgBouncer in transaction pooling mode
- setups requiring minimal connection footprint without dedicated session listeners

### Notify dispatcher

`projector.DispatcherStrategyNotify` pairs PostgreSQL `LISTEN`/`NOTIFY` with background reconciliation polling. Appends emitting `NOTIFY` wake up the dispatcher with sub-millisecond latency.

```go
daemon := projector.New(
	db,
	eventStore,
	projections,
	projector.WithDispatcherStrategy(projector.DispatcherStrategyNotify),
	projector.WithNotifyConnectionString(connStr),
	projector.WithNotifyChannel("projector_events"),
)
```

:::caution
The notify listener connection must hold a dedicated, long-lived PostgreSQL session. If using PgBouncer in transaction pooling mode, route the notification connection string to a direct database port or a session-pooled port.
:::

## Leader election strategies

When running multiple projector daemon processes, a leader coordinates projection assignment and rebalancing:

### Advisory lock strategy (Default)

`projector.LeaderStrategyAdvisory` coordinates leadership using PostgreSQL session-level advisory locks (`pg_try_advisory_lock`).

- **Pros**: Zero write overhead for leadership maintenance; lock releases immediately when a process disconnects.
- **Cons**: Requires a dedicated session connection; incompatible with transaction-pooled connection proxies.

### Lease-based strategy (PgBouncer-safe)

`projector.LeaderStrategyLease` maintains leadership via the `projector_leader_leases` table using short-lived transactions. The leader regularly renews its lease record during heartbeat cycles.

- **Pros**: Fully compatible with PgBouncer in transaction pooling mode; works seamlessly with standard serverless and containerized connection pools.
- **Cons**: Periodic lightweight write transactions for lease renewal.

```go
daemon := projector.New(
	db,
	eventStore,
	projections,
	projector.WithLeaderStrategy(projector.LeaderStrategyLease),
)
```

## PgBouncer and Transaction Pooling

Deploying event-sourced projector daemon processes behind connection proxies requires choosing the right strategies. Note that **both** lease-based leader election (`projector.LeaderStrategyLease`) and the poll dispatcher (`projector.DispatcherStrategyPoll`) are required for full PgBouncer transaction-pooling compatibility:

| Projector Feature | Advisory Lock / Session-based | Lease-based / Polling | PgBouncer Transaction Pooling Compatibility |
| --- | --- | --- | --- |
| **Leader Election** | `projector.LeaderStrategyAdvisory` | `projector.LeaderStrategyLease` | Compatible only with **Lease-based strategy**. |
| **Wakeup Dispatcher**| `projector.DispatcherStrategyNotify` | `projector.DispatcherStrategyPoll` | Compatible only with **Poll strategy** (or if notify connection bypasses transaction pooling). |
| **Projection Processing**| N/A | N/A | Fully compatible. Projections run within standard database transactions. |

To run the daemon in a fully PgBouncer transaction-pooling compatible mode:
1. Set the leader strategy to `projector.LeaderStrategyLease`.
2. Set the dispatcher strategy to `projector.DispatcherStrategyPoll`.
3. Ensure projector tables (including `projector_leader_leases`) are created via migrations.

### Supported Query Execution Modes

PgBouncer in transaction pooling mode does not support named server-side prepared statements because transactions within the same client session are routed across different database backends.

Configure `pgx` with a supported execution mode on `pgxpool.Config.ConnConfig.DefaultQueryExecMode`:

- **Simple Protocol (`pgx.QueryExecModeSimpleProtocol`)**: **Fully Supported**. Queries execute directly without preparation. Parameter conversions handle JSONB correctly.
- **Extended Protocol Exec (`pgx.QueryExecModeExec`)**: **Fully Supported**. Uses extended protocol parameter binding without preparing statements.
- **Describe Exec (`pgx.QueryExecModeDescribeExec`)**: **Fully Supported**.
- **Cache Describe (`pgx.QueryExecModeCacheDescribe`)**: **Fully Supported**. Caches statement descriptions using unnamed prepared statements (`Parse "" ...`), which are transaction-scoped and safe under PgBouncer.
- **Cache Statement (`pgx.QueryExecModeCacheStatement`)**: **Incompatible** with transaction pooling because it uses named prepared statements.

## Scaling across multiple instances

The projector scaling model is deterministic: each projection is assigned to exactly one live daemon instance at a time.

If you register ten projections and run a single daemon instance, that instance runs all ten. When a second instance starts and registers itself, the leader computes a balanced distribution (sorting projection names and live instance IDs, then assigning round-robin). Each instance then runs approximately five projections.

When an instance joins or leaves:

1. The instance registers and begins heartbeating in `projector_instances`.
2. The leader detects the cluster membership change during its rebalance loop.
3. Updated assignments are written to `projection_assignments`.
4. Instances stop projection loops they no longer own and start newly assigned ones.
5. If the leader fails or stops heartbeating, another instance assumes leadership and resumes coordination.

## Gaps, frontiers, and safe progress

In PostgreSQL, sequence values assigned to `global_position` guarantee uniqueness and monotonicity, but **not** transaction commit order. A transaction appending at position `100` might commit before a concurrent transaction appending at position `99`.

If a projector advanced naively to the highest position visible in a query, it could skip position `99` permanently if position `99` committed moments later.

The projector runtime eliminates this race using an **unscoped frontier probe**:

1. Read the projection's current checkpoint.
2. Read a window of events starting from that checkpoint.
3. Compute the contiguous prefix starting from `checkpoint + 1`.
4. Process only events within that safe contiguous frontier.
5. Persist the new checkpoint atomically with the projection batch.

### Stale gaps and safe-harbor recovery

If an expected sequence number is missing (for example, due to an aborted transaction or a rolled-back append), the daemon pauses and retries for up to `StaleGapThreshold` (default `30s`).

If the position remains missing after the threshold has elapsed, the daemon applies safe-harbor advancement: it advances the checkpoint past the gap, maintaining `StaleGapHarborLag` positions behind the highest visible head, and writes an audit record to `projection_gap_skips`.

This prevents a projection from being stalled indefinitely while maintaining a permanent record of skipped sequence numbers for operational audit.

## Operational best practices

- **Stable Projection Names**: `Name()` is the projection's identity for checkpoints and distributed assignments. Keep projection names stable across releases.
- **Short Write Transactions**: Keep store `Append` transactions short on the write side to minimize sequence visibility delays.
- **Monitor Projection Lag**: Use the `Observer` interface with Prometheus or structured logs to monitor `Lag` and `Duration`.
- **Audit Gap Skips**: Periodically inspect `projection_gap_skips` in PostgreSQL to ensure no unexpected sequence holes occur in production.
