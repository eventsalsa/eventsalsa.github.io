---
title: Projector
description: Run projections asynchronously with eventsalsa/projector.
---

`eventsalsa/projector` is the asynchronous projection engine in the eventsalsa bundle. It builds on `eventsalsa/store` and provides a horizontally scalable, PostgreSQL-native runtime for distributed projections.

The projector is not a second event store. It is the runtime that reads the store's global log safely, manages checkpoints, and drives projections forward without requiring Redis, ZooKeeper, or an external message broker just to coordinate which instance handles what.

At a practical level, the component covers:

- running projections outside the request path for eventual consistency
- scaling projections deterministically across multiple projector instances
- checkpoint management and read-model updates across both PostgreSQL and external data stores
- gap-aware frontier progression under concurrent out-of-order sequence commits
- configurable error classification, failure policies, and dead-letter handling
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
3. a projection registry (`*projector.Registry`) containing one or more projections

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

Register the projection with `projector.NewRegistry()`, scoping it to the `"Order"` stream type via `projector.OnStreamTypes(...)`, and pass the registry to `projector.New(...)`:

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

	registry := projector.NewRegistry()
	if err := registry.Add(&OrderOverviewProjection{}, projector.OnStreamTypes("Order")); err != nil {
		log.Fatal(err)
	}

	daemon := projector.New(
		db,
		eventStore,
		registry,
		projector.WithBatchSize(100),
		projector.WithPollInterval(500*time.Millisecond),
	)

	if err := daemon.Start(ctx); err != nil {
		log.Fatal(err)
	}
}
```

If your projections do not need registration options, you can also build the registry in one call with `projector.FromProjections(&OrderOverviewProjection{})`.

`(*projector.Daemon).Start(...)` blocks until the context is canceled or a fatal internal error occurs. This makes the daemon the main entrypoint for a background projector daemon binary or service.

## Full configuration

The projector daemon uses functional options. Most systems run well with the default configuration, but the runtime exposes full control over batching, polling intervals, timeouts, and table names:

```go
daemon := projector.New(
	db,
	eventStore,
	registry,
	projector.WithBatchSize(200),
	projector.WithBatchPause(100*time.Millisecond),
	projector.WithBatchTimeout(20*time.Second),
	projector.WithDetachedApplyTimeout(15*time.Second),
	projector.WithCheckpointTimeout(5*time.Second),
	projector.WithShutdownTimeout(5*time.Second),
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
| `WithBatchTimeout(d)` | `30s` | Maximum duration for a single batch processing cycle. |
| `WithDetachedApplyTimeout(d)` | `30s` | Maximum duration for the external apply phase of a detached projection; effective budget is `min(BatchTimeout, DetachedApplyTimeout)`. |
| `WithCheckpointTimeout(d)` | `5s` | Independent timeout budget for the post-apply checkpoint transaction of a detached projection. |
| `WithShutdownTimeout(d)` | `5s` | Maximum duration to wait for graceful daemon shutdown and batch draining. |
| `WithMaxConsecutiveFailures(n)` | `5` | Fatal threshold for consecutive unclassified batch errors under `FailurePolicyFailFast`. |
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
Projections must **never** call `Commit()` or `Rollback()` on the provided `tx`. The daemon manages the transaction lifecycle.
:::

## Stream and Event Filtering

Projections can be scoped at registration time to process only specific streams or events:

- **`projector.OnStreamTypes(streamTypes ...string)`**: filters events by `StreamType` (e.g. `"Order"`, `"Payment"`).
- **`projector.OnEventTypes(eventTypes ...string)`**: filters events by `EventType` (e.g. `"OrderPlaced"`, `"OrderConfirmed"`).

```go
registry := projector.NewRegistry()

_ = registry.Add(&OrderOverviewProjection{}, projector.OnStreamTypes("Order"))
_ = registry.Add(&AuditLogProjection{}, projector.OnEventTypes("UserRegistered", "PasswordReset"))
```

Events that do not match the filter are skipped cleanly in memory without invoking `Handle`, while the projection checkpoint still advances safely to the unscoped frontier of the batch window.

## Projection shapes: batching and external read models

In the examples so far, `OrderOverviewProjection` implemented `projector.Projection`, which is **single-event and transaction-attached** (`Handle(ctx, tx, event)`): the daemon calls `Handle` once per event inside the PostgreSQL transaction that also persists the checkpoint.

Depending on where your read model lives and how it ingests writes, `eventsalsa/projector` supports **three additional projection shapes**:

| Interface | Mode | `Handle` Signature | Best Fit |
| :--- | :--- | :--- | :--- |
| `Projection` | Single-event, transaction-attached | `(ctx, tx, event)` | Standard SQL read models in the same PostgreSQL database. |
| `BatchProjection` | Batched, transaction-attached | `(ctx, tx, events)` | Larger or high-throughput SQL read model updates in the same PostgreSQL database (multi-row upserts, in-memory rollups). |
| `DetachedBatchProjection` | Batched, transaction-detached | `(ctx, events)` | External search engines and analytical stores with bulk ingestion endpoints (e.g. Typesense, Elasticsearch, ClickHouse). |
| `DetachedProjection` | Single-event, transaction-detached | `(ctx, event)` | External data stores outside PostgreSQL (e.g. Redis, DynamoDB, MongoDB) where event traffic is low to moderate. |

Because Go does not allow two `Handle` methods with different signatures on the same type, each struct implements one shape. `registry.Add(...)` and `projector.FromProjections(...)` infer the shape automatically, or you can use the explicit typed registration methods (`AddProjection`, `AddBatch`, `AddDetachedBatch`, `AddDetached`).

### 1. Transactional batch projections (`BatchProjection`)

Use `BatchProjection` when your read model lives in the **same PostgreSQL database**, but executing a separate SQL statement per event creates unnecessary round-trip overhead during high-throughput bursts or historical replays.

Typical use cases include:
- **In-memory pre-aggregation / rollups**: Summing counters, quantities, or ledger deltas across a batch of events in Go memory and flushing one consolidated update per affected row.
- **Multi-row bulk inserts / upserts**: Writing an entire batch of rows in a single SQL round trip using `UNNEST` or `pgx.Batch` while keeping the read model update atomic with the projection checkpoint.

Here is an example that aggregates `OrderLineAdded` events across a batch window in memory and updates a `product_daily_sales_v1` rollup table in a single `UNNEST` upsert inside `tx`:

```go
package projections

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/eventsalsa/store"
)

type OrderLineAdded struct {
	SKU            string `json:"sku"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
}

type ProductDailySalesProjection struct{}

func (p *ProductDailySalesProjection) Name() string {
	return "product_daily_sales_v1"
}

func (p *ProductDailySalesProjection) Handle(ctx context.Context, tx pgx.Tx, events []store.PersistedEvent) error {
	type bucketKey struct {
		day time.Time
		sku string
	}
	type bucketDelta struct {
		unitsSold    int64
		revenueCents int64
		lastPos      int64
	}

	// 1. Collapse all events in the batch window into per-(day, sku) deltas in memory
	deltas := make(map[bucketKey]*bucketDelta)
	for _, event := range events {
		if event.EventType != "OrderLineAdded" {
			continue
		}

		var line OrderLineAdded
		if err := json.Unmarshal(event.Payload, &line); err != nil {
			return fmt.Errorf("unmarshal OrderLineAdded at pos %d: %w", event.GlobalPosition, err)
		}

		key := bucketKey{
			day: event.CreatedAt.UTC().Truncate(24 * time.Hour),
			sku: line.SKU,
		}
		d, exists := deltas[key]
		if !exists {
			d = &bucketDelta{}
			deltas[key] = d
		}
		d.unitsSold += int64(line.Quantity)
		d.revenueCents += int64(line.Quantity) * line.UnitPriceCents
		d.lastPos = event.GlobalPosition
	}

	if len(deltas) == 0 {
		return nil
	}

	// 2. Flush all aggregated buckets in a single multi-row SQL upsert
	days := make([]time.Time, 0, len(deltas))
	skus := make([]string, 0, len(deltas))
	units := make([]int64, 0, len(deltas))
	revenues := make([]int64, 0, len(deltas))
	positions := make([]int64, 0, len(deltas))

	for k, d := range deltas {
		days = append(days, k.day)
		skus = append(skus, k.sku)
		units = append(units, d.unitsSold)
		revenues = append(revenues, d.revenueCents)
		positions = append(positions, d.lastPos)
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO product_daily_sales_v1 (sale_date, sku, units_sold, revenue_cents, last_global_position)
		SELECT * FROM UNNEST($1::date[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[])
		ON CONFLICT (sale_date, sku) DO UPDATE
		SET units_sold           = product_daily_sales_v1.units_sold + EXCLUDED.units_sold,
		    revenue_cents        = product_daily_sales_v1.revenue_cents + EXCLUDED.revenue_cents,
		    last_global_position = EXCLUDED.last_global_position
		WHERE product_daily_sales_v1.last_global_position < EXCLUDED.last_global_position
	`, days, skus, units, revenues, positions)
	return err
}
```

Register the batch projection with `registry.Add` or `registry.AddBatch`:

```go
_ = registry.AddBatch(&ProductDailySalesProjection{}, projector.OnEventTypes("OrderLineAdded"))
```

### 2. Detached batch projections (`DetachedBatchProjection`)

Use `DetachedBatchProjection` when your read model lives **outside PostgreSQL** and the destination provides a **bulk ingestion API**—such as **Typesense**, Elasticsearch, OpenSearch, or ClickHouse.

Instead of holding a PostgreSQL transaction open during external network calls or issuing hundreds of individual HTTP requests, the daemon:
1. Probes the safe event frontier and releases the database connection.
2. Calls `Handle(ctx, events)` with **no database transaction or row locks held**.
3. Persists the updated checkpoint in a short, separate transaction once `Handle` succeeds.

Here is an example indexing catalog events into **Typesense** using its bulk document import endpoint (`upsert` action) rather than singular document mutations:

```go
package projections

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/eventsalsa/projector/failure"
	"github.com/eventsalsa/store"
)

type ProductUpserted struct {
	Title       string   `json:"title"`
	Category    string   `json:"category"`
	PriceCents  int64    `json:"price_cents"`
	InStock     bool     `json:"in_stock"`
	SearchTags  []string `json:"search_tags"`
}

type TypesenseProductDoc struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Category      string   `json:"category"`
	PriceCents    int64    `json:"price_cents"`
	InStock       bool     `json:"in_stock"`
	SearchTags    []string `json:"search_tags"`
	StreamVersion int64    `json:"stream_version"`
}

type TypesenseBulkImporter interface {
	ImportDocuments(ctx context.Context, collection string, docs []TypesenseProductDoc) error
}

type TypesenseCatalogProjection struct {
	importer TypesenseBulkImporter
}

func NewTypesenseCatalogProjection(importer TypesenseBulkImporter) *TypesenseCatalogProjection {
	return &TypesenseCatalogProjection{importer: importer}
}

func (p *TypesenseCatalogProjection) Name() string {
	return "typesense_catalog_v1"
}

func (p *TypesenseCatalogProjection) Handle(ctx context.Context, events []store.PersistedEvent) error {
	// Collapse to the latest event per product stream within the batch window
	latestByProduct := make(map[string]TypesenseProductDoc, len(events))

	for _, event := range events {
		var payload ProductUpserted
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			// Malformed JSON cannot be fixed by retrying
			return failure.Permanent(fmt.Errorf("unmarshal product %s: %w", event.StreamID, err))
		}

		latestByProduct[event.StreamID] = TypesenseProductDoc{
			ID:            event.StreamID,
			Title:         payload.Title,
			Category:      payload.Category,
			PriceCents:    payload.PriceCents,
			InStock:       payload.InStock,
			SearchTags:    payload.SearchTags,
			StreamVersion: event.StreamVersion,
		}
	}

	if len(latestByProduct) == 0 {
		return nil
	}

	docs := make([]TypesenseProductDoc, 0, len(latestByProduct))
	for _, doc := range latestByProduct {
		docs = append(docs, doc)
	}

	// Send the entire batch to Typesense's bulk import endpoint in one HTTP request
	if err := p.importer.ImportDocuments(ctx, "products", docs); err != nil {
		return failure.Retryable(fmt.Errorf("typesense bulk import: %w", err))
	}

	return nil
}
```

Register it on the registry:

```go
_ = registry.AddDetachedBatch(
	NewTypesenseCatalogProjection(typesenseClient),
	projector.OnStreamTypes("Product"),
)
```

### 3. Detached single-event projections (`DetachedProjection`)

Use `DetachedProjection` when your read model lives in an **external data store outside PostgreSQL** (such as Redis, DynamoDB, MongoDB, or an external HTTP API) and event traffic for that projection is low to moderate, or each event maps naturally to a single key/document operation where custom batch-aggregation logic is unnecessary.

Like `DetachedBatchProjection`, the handler runs without holding a PostgreSQL connection or transaction lock, and the checkpoint is persisted in a fast transaction after the batch window completes.

Here is an example maintaining a customer's subscription tier in **Redis**:

```go
package projections

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/eventsalsa/projector/failure"
	"github.com/eventsalsa/store"
)

type SubscriptionTierChanged struct {
	PlanTier  string `json:"plan_tier"`
	ExpiresAt string `json:"expires_at"`
}

type RedisTierStore interface {
	SetCustomerTierIfNewer(ctx context.Context, customerID, tier, expiresAt string, streamVersion int64) error
}

type CustomerTierCacheProjection struct {
	cache RedisTierStore
}

func NewCustomerTierCacheProjection(cache RedisTierStore) *CustomerTierCacheProjection {
	return &CustomerTierCacheProjection{cache: cache}
}

func (p *CustomerTierCacheProjection) Name() string {
	return "customer_tier_cache_v1"
}

func (p *CustomerTierCacheProjection) Handle(ctx context.Context, event store.PersistedEvent) error {
	var payload SubscriptionTierChanged
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return failure.Permanent(fmt.Errorf("unmarshal SubscriptionTierChanged: %w", err))
	}

	if err := p.cache.SetCustomerTierIfNewer(
		ctx,
		event.StreamID,
		payload.PlanTier,
		payload.ExpiresAt,
		event.StreamVersion,
	); err != nil {
		return failure.Retryable(fmt.Errorf("redis update customer tier: %w", err))
	}

	return nil
}
```

Register it with `registry.Add` or `registry.AddDetached`:

```go
_ = registry.AddDetached(
	NewCustomerTierCacheProjection(redisStore),
	projector.OnEventTypes("SubscriptionTierChanged"),
)
```

### Detached execution semantics, idempotency, and timeout budgets

Because detached projections (`DetachedProjection` and `DetachedBatchProjection`) apply changes outside the PostgreSQL checkpoint transaction, delivery is **at-least-once**. Events in a batch can be applied more than once if:
- the process crashes after the external apply succeeds but before the checkpoint transaction commits,
- the post-apply checkpoint transaction encounters a serialization conflict or ownership rebalance, or
- a batch fails partway through (`k` of `N` events) and is retried on the next poll cycle.

Follow these guidelines when writing detached handlers:

1. **Idempotent writes with version guards**: Key external documents or cache entries deterministically (for example, by `event.StreamID`) and store `event.StreamVersion` or `event.GlobalPosition` alongside the record so replayed older events never overwrite newer state.
2. **Honor context cancellation**: The daemon bounds external apply execution with `WithDetachedApplyTimeout(d)` (default `30s`, capped by `WithBatchTimeout(d)`). Always pass `ctx` to your HTTP/database client so slow requests abort promptly when the deadline expires.
3. **Independent checkpoint budget**: The post-apply checkpoint transaction uses its own timeout budget (`WithCheckpointTimeout(d)`, default `5s`) rooted in the daemon's lifecycle context rather than inheriting the apply deadline. A slow external destination that finishes just before its deadline will never starve the subsequent PostgreSQL checkpoint write.

## Error classification, failure policies, and poison handlers

Not all projection failures should be treated the same way. A SQL syntax error in a local transactional projection usually indicates a bug that requires operator attention, whereas a `503 Service Unavailable` from an external search cluster should back off and retry without crashing the daemon, and a single malformed historical event payload may need to be routed to a dead-letter queue (DLQ).

### Classifying errors (`projector/failure`)

Handlers can classify errors explicitly at the failure site using `github.com/eventsalsa/projector/failure`:

- **`failure.Retryable(err)`**: Marks `err` as a transient failure (network timeout, rate limit, HTTP 5xx). The daemon backs off exponentially up to `MaxPollInterval`, retries the batch, emits `OnProjectionDegraded`, and **never** treats the failure as fatal.
- **`failure.Permanent(err)`**: Marks `err` as an unrecoverable failure that retrying cannot fix (malformed payload, schema violation). If a poison handler is registered, the batch is handed to the poison handler and skipped; otherwise, the daemon stops only that projection and keeps all other projections running.

```go
import "github.com/eventsalsa/projector/failure"

func (p *WebhookProjection) Handle(ctx context.Context, event store.PersistedEvent) error {
	if err := p.deliver(ctx, event); err != nil {
		if isTransientNetworkError(err) {
			return failure.Retryable(err)
		}
		return failure.Permanent(err)
	}
	return nil
}
```

Both functions wrap the original error, preserving `errors.Is` and `errors.As` inspection across error chains.

### Per-projection failure policies

When a handler returns an **unclassified** error, the daemon consults the projection's `FailurePolicy`. Each projection shape gets a sensible default:

- **Transactional projections (`Projection`, `BatchProjection`)**: Default to `projector.FailurePolicyFailFast`. After `WithMaxConsecutiveFailures(n)` (default `5`) consecutive unclassified errors, `daemon.Start(ctx)` returns `projector.ErrConsecutiveFailures`.
- **Detached projections (`DetachedProjection`, `DetachedBatchProjection`)**: Default to `projector.FailurePolicyRetry`. Unclassified errors are retried with exponential backoff and reported via `OnProjectionDegraded` without crashing the daemon.

You can override the default policy for any projection at registration time:

```go
_ = registry.Add(
	&OrderOverviewProjection{},
	projector.OnStreamTypes("Order"),
	projector.WithFailurePolicy(projector.FailurePolicyRetry),
)
```

| Failure Scenario | Daemon Behavior |
| :--- | :--- |
| `failure.Retryable(err)` or context deadline/cancellation | Back off up to `MaxPollInterval`, retry the batch, emit `OnProjectionDegraded` (never fatal). |
| `failure.Permanent(err)` (no poison handler) | Stop the affected projection and emit `OnProjectionDegraded`; all other projections and leadership continue running. |
| `failure.Permanent(err)` (poison handler returns `nil`) | Record the batch via the poison handler, advance the checkpoint past the batch, emit `OnPoisonBatchSkipped`, and continue. |
| `failure.Permanent(err)` (poison handler returns an error) | Stop the affected projection without advancing the checkpoint. |
| Unclassified error + `FailurePolicyFailFast` | Retry up to `MaxConsecutiveFailures`, then stop the daemon with `ErrConsecutiveFailures`. |
| Unclassified error + `FailurePolicyRetry` | Treated identically to `failure.Retryable(err)`. |

### Poison handlers (dead-letter queues)

Register a `projector.WithPoisonHandler(...)` callback to capture and skip batches that fail with `failure.Permanent(err)`:

```go
_ = registry.AddDetachedBatch(
	NewTypesenseCatalogProjection(typesenseClient),
	projector.OnStreamTypes("Product"),
	projector.WithPoisonHandler(func(
		ctx context.Context,
		projectionName string,
		events []store.PersistedEvent,
		cause error,
	) error {
		// Persist the failing batch to your dead-letter table or object store
		return dlqStore.RecordBatch(ctx, projectionName, events, cause)
	}),
)
```

Poison handling operates at the **whole-batch** level: the callback receives every event in the failing batch window, and returning `nil` advances the projection's checkpoint past that batch and emits `OnPoisonBatchSkipped`. For transactional projections, the batch transaction was already rolled back prior to invoking the poison handler; for detached projections, some events in the batch may already have been applied to the external store before the error occurred, so downstream consumers of your DLQ should rely on the same idempotency guards as the projection itself.

## Observability and telemetry

The projector daemon exposes internal runtime events and metrics via a pluggable `Observer` interface without executing any extra out-of-band database polling queries:

```go
type Observer interface {
	OnBatchProcessed(ctx context.Context, stats BatchStats)
	OnHeartbeat(ctx context.Context, stats DaemonStats)
	OnGapDetected(ctx context.Context, stats GapStats)
	OnGapSkipped(ctx context.Context, stats GapStats)
	OnProjectionDegraded(ctx context.Context, stats DegradedStats)
	OnPoisonBatchSkipped(ctx context.Context, stats PoisonBatchStats)
	OnRebalance(ctx context.Context, assignments map[string]uuid.UUID)
}
```

### Telemetry data structures

- **`BatchStats`**: contains batch execution latency (`Duration`), global checkpoint positions (`StartPosition`, `LastPosition`, `HeadPosition`), calculated event lag (`Lag = max(0, HeadPosition - LastPosition)`), throughput counts (`EventsRead` for the window and `EventsHandled` for events applied after registration filtering), safe-harbor stale skip indicator (`StaleSkipped`), detached execution flag (`Detached`), and error status (`Error`).
- **`DaemonStats`**: contains instance UUID (`InstanceID`) and leadership status (`IsLeader`).
- **`GapStats`**: contains projection name (`ProjectionName`), missing sequence coordinate (`GapPosition`), visible stream head (`HighestVisible`), and elapsed duration (`StaleFor`).
- **`DegradedStats`**: contains projection name (`ProjectionName`), timestamp of the first failure in the current run (`FirstFailureAt`), consecutive failure count (`ConsecutiveFailures`), and the latest error (`LastError`), emitted whenever a projection fails without crashing the daemon.
- **`PoisonBatchStats`**: contains projection name (`ProjectionName`), checkpoint target advanced to (`TargetPosition`), skipped event count (`EventCount`), and the permanent failure cause (`Cause`).

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
	batchDuration  *prometheus.HistogramVec
	lagGauge       *prometheus.GaugeVec
	eventsHandled  *prometheus.CounterVec
	checkpointPos  *prometheus.GaugeVec
	degradedTotal  *prometheus.CounterVec
	poisonSkipped  *prometheus.CounterVec
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
		degradedTotal: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "projector_degraded_failures_total",
			Help: "Total non-fatal degraded failures experienced by projection.",
		}, []string{"projection"}),
		poisonSkipped: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "projector_poison_batches_skipped_total",
			Help: "Total poison batches recorded and skipped by projection.",
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

func (p *PrometheusObserver) OnProjectionDegraded(_ context.Context, stats projector.DegradedStats) {
	p.degradedTotal.WithLabelValues(stats.ProjectionName).Inc()
}

func (p *PrometheusObserver) OnPoisonBatchSkipped(_ context.Context, stats projector.PoisonBatchStats) {
	p.poisonSkipped.WithLabelValues(stats.ProjectionName).Inc()
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
	registry,
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
	registry,
	projector.WithLeaderStrategy(projector.LeaderStrategyLease),
)
```

## PgBouncer and Transaction Pooling

Deploying event-sourced projector daemon processes behind connection proxies requires choosing the right strategies. Note that **both** lease-based leader election (`projector.LeaderStrategyLease`) and the poll dispatcher (`projector.DispatcherStrategyPoll`) are required for full PgBouncer transaction-pooling compatibility:

| Projector Feature | Advisory Lock / Session-based | Lease-based / Polling | PgBouncer Transaction Pooling Compatibility |
| --- | --- | --- | --- |
| **Leader Election** | `projector.LeaderStrategyAdvisory` | `projector.LeaderStrategyLease` | Compatible only with **Lease-based strategy**. |
| **Wakeup Dispatcher**| `projector.DispatcherStrategyNotify` | `projector.DispatcherStrategyPoll` | Compatible only with **Poll strategy** (or if notify connection bypasses transaction pooling). |
| **Projection Processing**| N/A | N/A | Fully compatible. Transactional projections run within standard database transactions, and detached projections use short probe and checkpoint transactions. |

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

## Running multiple domain daemons (`errgroup`)

When building modular monoliths or multi-context services, applications often run multiple independent `Daemon` instances within a single OS process (for example, separate domain stores like `ledger.events` and `billing.events`, each with dedicated projections, checkpoints, and leases).

The `*projector.Daemon` is designed to be a first-class citizen in [`golang.org/x/sync/errgroup`](https://pkg.go.dev/golang.org/x/sync/errgroup) workflows:

- **Clean shutdown**: `daemon.Start(ctx)` returns `nil` when `ctx` is canceled (both during steady-state projection loops and during startup registration), preventing intentional cancellations from polluting `errgroup.Wait()`.
- **Fatal failure propagation**: Unrecoverable faults (such as exceeding `WithMaxConsecutiveFailures` under `FailurePolicyFailFast`) return non-nil errors, immediately triggering `errgroup` context cancellation across sibling daemons.
- **Graceful batch draining**: When `ctx` is canceled, in-flight batches are granted up to `WithShutdownTimeout(d)` (default `5s`) to finish processing and commit before forced cancellation.
- **State and health inspection**: `daemon.IsRunning()` and `daemon.IsLeader()` allow HTTP readiness, liveness, and status probes (`/healthz`, `/readyz`) to query daemon health directly without executing out-of-band database queries.

### Example: Multi-Daemon worker process

```go
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/eventsalsa/projector"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// 1. Initialize domain daemons with lease-based leader election.
	// FromProjections accepts any of the four projection handler shapes.
	ledgerDaemon := projector.New(
		db,
		ledgerStore,
		projector.FromProjections(ledgerProjections...),
		projector.WithLeaderStrategy(projector.LeaderStrategyLease),
		projector.WithProjectorLeaderLeasesTable("ledger.projector_leader_leases"),
		projector.WithProjectorInstancesTable("ledger.projector_instances"),
		projector.WithProjectionAssignmentsTable("ledger.projection_assignments"),
		projector.WithProjectionCheckpointsTable("ledger.projection_checkpoints"),
		projector.WithShutdownTimeout(15*time.Second),
	)

	billingDaemon := projector.New(
		db,
		billingStore,
		projector.FromProjections(billingProjections...),
		projector.WithLeaderStrategy(projector.LeaderStrategyLease),
		projector.WithProjectorLeaderLeasesTable("billing.projector_leader_leases"),
		projector.WithProjectorInstancesTable("billing.projector_instances"),
		projector.WithProjectionAssignmentsTable("billing.projection_assignments"),
		projector.WithProjectionCheckpointsTable("billing.projection_checkpoints"),
		projector.WithShutdownTimeout(15*time.Second),
	)

	daemons := []*projector.Daemon{ledgerDaemon, billingDaemon}

	// 2. Coordinate concurrent execution via errgroup
	g, gCtx := errgroup.WithContext(ctx)
	for _, d := range daemons {
		g.Go(func() error {
			return d.Start(gCtx)
		})
	}

	if err := g.Wait(); err != nil {
		log.Fatalf("projector worker exited with fatal error: %v", err)
	}
}
```

### Operational considerations for multi-daemon processes

1. **Connection Pool Sizing**: Ensure your shared `*pgxpool.Pool` has sufficient connections for all concurrent daemons:
   `PoolSize_min >= NumDaemons * (1 + MaxConcurrentProjections) + Headroom`
   Note that detached projections (`DetachedProjection`, `DetachedBatchProjection`) do not hold a pooled database connection while applying to their external read model—they only acquire connections briefly during their frontier probe and checkpoint transactions.
2. **Lease Tables vs Advisory Locks**: Multi-daemon deployments sharing a PostgreSQL database must use `projector.LeaderStrategyLease` with domain-specific lease tables (e.g. `schema.projector_leader_leases`). `projector.LeaderStrategyAdvisory` uses a single well-known lock key across the database, which would cause unrelated domain daemons to contend for leadership.
3. **Distinct NOTIFY Channels**: When using `projector.DispatcherStrategyNotify`, assign each domain daemon a unique channel via `projector.WithNotifyChannel("domain_events")` to prevent wakeup crosstalk between different domain event streams.

## Gaps, frontiers, and safe progress

In PostgreSQL, sequence values assigned to `global_position` guarantee uniqueness and monotonicity, but **not** transaction commit order. A transaction appending at position `100` might commit before a concurrent transaction appending at position `99`.

If a projector advanced naively to the highest position visible in a query, it could skip position `99` permanently if position `99` committed moments later.

The projector runtime eliminates this race using an **unscoped frontier probe**:

1. Read the projection's current checkpoint.
2. Read a window of events starting from that checkpoint outside the batch transaction.
3. Compute the contiguous prefix starting from `checkpoint + 1`.
4. Process only events within that safe contiguous frontier.
5. Persist the new checkpoint atomically with the projection batch (or in the short post-apply transaction for detached projections).

### Stale gaps and safe-harbor recovery

If an expected sequence number is missing (for example, due to an aborted transaction or a rolled-back append), the daemon pauses and retries for up to `StaleGapThreshold` (default `30s`).

If the position remains missing after the threshold has elapsed, the daemon applies safe-harbor advancement: it advances the checkpoint past the gap, maintaining `StaleGapHarborLag` positions behind the highest visible head, and writes an audit record to `projection_gap_skips`. For detached projections, the daemon revalidates the stale-gap plan before applying and discards the checkpoint write if the missing position appeared while the external apply was in flight.

This prevents a projection from being stalled indefinitely while maintaining a permanent record of skipped sequence numbers for operational audit.

## Operational best practices

- **Stable Projection Names**: `Name()` is the projection's identity for checkpoints and distributed assignments. Keep projection names stable across releases.
- **Choose the Right Projection Shape**: Use `Projection` or `BatchProjection` when the read model lives in the same PostgreSQL database so mutations and checkpoints commit atomically; use `DetachedBatchProjection` or `DetachedProjection` for external systems so network I/O never holds PostgreSQL connections or locks.
- **Short Write Transactions**: Keep store `Append` transactions short on the write side to minimize sequence visibility delays.
- **Monitor Projection Lag and Degradation**: Use the `Observer` interface (`OnBatchProcessed`, `OnProjectionDegraded`, `OnPoisonBatchSkipped`) with Prometheus or structured logs to monitor `Lag`, `Duration`, and retry loops.
- **Audit Gap Skips**: Periodically inspect `projection_gap_skips` in PostgreSQL to ensure no unexpected sequence holes occur in production.
