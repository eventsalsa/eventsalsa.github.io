---
title: Store
description: Append, read, and project events with eventsalsa/store.
---

`eventsalsa/store` is the append-only event store in the eventsalsa bundle. It is intentionally small: it gives you immutable event persistence, optimistic concurrency, aggregate stream reads, global log reads, consumer contracts for projections, and a PostgreSQL implementation that works inside your own `*sql.Tx`.

That shape matters. The store does not try to own your domain model, your application services, or your transaction boundaries. It gives you a reliable event log and the primitives around it, then gets out of the way.

At a practical level, the component covers:

- appending one or more events for a single aggregate instance
- optimistic concurrency through expected versions
- reading an aggregate stream back in version order
- reading the global log for consumers and projections
- projection contracts through the `consumer` package
- migration generation for the PostgreSQL schema
- event mapping code generation through `eventmap-gen`

## Appending events

Appending is the write operation at the heart of the store. You construct one or more `store.Event` values, open a SQL transaction, and call `Append`.

Every append is scoped to one aggregate instance. In other words, the events in a single append call must all share the same `AggregateType` and `AggregateID`. That matches the shape of a command in a typical event-sourced system: one command loads one aggregate, makes a decision, emits one or more events, and commits them atomically.

In a healthy codebase, this usually lives in a repository adapter or persistence adapter rather than directly in an HTTP handler or service layer.

### What is in a store event?

Before persistence, you work with `store.Event`. After persistence, the store returns `store.PersistedEvent`, which adds the values assigned by the database during append.

| Field | Meaning |
| --- | --- |
| `AggregateType` | The logical type of the aggregate, for example `Order`. Keep it stable. |
| `AggregateID` | The identifier of one aggregate instance, for example an order ID. |
| `AggregateVersion` | The event's position inside that aggregate stream. The store assigns it during append. |
| `GlobalPosition` | The event's position in the global log. The store assigns it during append. Useful for consumers and projections. |
| `EventType` | The logical event name, for example `OrderPlaced`. |
| `EventVersion` | The schema version of the payload for that event type. |
| `Payload` | The serialized event body. In the examples below it is JSON, but the field itself is just `[]byte`. |
| `Metadata` | Cross-cutting metadata such as actor, tenant, request information, or audit context. With the default PostgreSQL schema, JSON bytes are the natural fit here. |
| `TraceID` | Optional tracing identifier for distributed tracing. |
| `CorrelationID` | Optional identifier used to group related work across events. |
| `CausationID` | Optional identifier for the direct cause of this event, often a command ID or upstream event ID. |
| `EventID` | A unique identifier for the event itself. |
| `CreatedAt` | The timestamp carried with the event. |

Two values deserve special attention because they are easy to conflate:

- **`AggregateVersion`** is local to one aggregate stream. It starts at `1` for the first event of a given aggregate and then increases by one for each subsequent event in that stream.
- **`GlobalPosition`** is global to the store. It is assigned from the event log sequence and is useful for reading the whole log in order.

If an order is currently at aggregate version `7` and a command appends two new events, those events will be stored at aggregate versions `8` and `9`. At the same time, they also get global positions in the shared event log.

:::caution
`global_position` is useful for consumers, but it is **not** a safe naive checkpoint frontier under concurrent writers. PostgreSQL sequences guarantee uniqueness, not commit order. A lower position can become visible after a higher one has already been returned.
:::

### Optimistic concurrency

The store uses expected versions for optimistic concurrency. When you append, you tell the store what version you believe the aggregate is currently at. If reality does not match that expectation, the append fails with `store.ErrOptimisticConcurrency`.

That is the normal safety mechanism for command handling in event sourcing. You load the aggregate, make a decision based on its current state, and append only if nobody else has changed that stream in the meantime.

`eventsalsa/store` gives you three expected-version modes:

| Call | Meaning | Typical use |
| --- | --- | --- |
| `store.NoStream()` | The aggregate must not exist yet. | Creating a new aggregate. |
| `store.Exact(n)` | The aggregate must currently be at version `n`. | Normal updates to an existing aggregate. |
| `store.Any()` | Skip version validation entirely. | Specialized cases such as imports or internal tooling. |

`NoStream()` is the clearest way to express aggregate creation, even though `Exact(0)` is equivalent under the hood.

In practice, optimistic concurrency looks like this:

```go
expected := store.NoStream()
if order.Version > 0 {
	expected = store.Exact(order.Version)
}

result, err := eventStore.Append(ctx, tx, expected, events)
if err != nil {
	return err
}

newVersion := result.ToVersion()
```

If two requests both load an order at version `7`, one of them can win and append version `8`. The other still tries `store.Exact(7)`, sees that the aggregate has moved on, and gets `store.ErrOptimisticConcurrency` instead of silently writing over someone else's decision.

The PostgreSQL schema reinforces this with a unique constraint on `(aggregate_type, aggregate_id, aggregate_version)`. That database-level check is the safety net in case two transactions race between the version check and the insert.

### A repository adapter example

This is the kind of code you would typically keep in an infrastructure adapter for an `Order` aggregate:

```go
package persistence

import (
	"context"
	"database/sql"

	"github.com/eventsalsa/store"
	"github.com/eventsalsa/store/postgres"
	orderes "github.com/acme/shop/internal/infrastructure/order/persistence/generated"
)

type CommandMetadata struct {
	CommandID     string
	CorrelationID string
	TraceID       string
}

type OrderRepository struct {
	db         *sql.DB
	eventStore *postgres.Store
}

func (r *OrderRepository) Save(ctx context.Context, order *Order, pending []any, meta CommandMetadata) error {
	events, err := orderes.ToESEvents(
		"Order",
		order.ID,
		pending,
		orderes.WithCausationID(meta.CommandID),
		orderes.WithCorrelationID(meta.CorrelationID),
		orderes.WithTraceID(meta.TraceID),
	)
	if err != nil {
		return err
	}

	expected := store.NoStream()
	if order.Version > 0 {
		expected = store.Exact(order.Version)
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	result, err := r.eventStore.Append(ctx, tx, expected, events)
	if err != nil {
		return err
	}

	order.Version = result.ToVersion()

	if err := tx.Commit(); err != nil {
		return err
	}

	return nil
}
```

The important part is not the exact repository shape. The important part is the flow:

1. build store events from domain events
2. choose the expected version from the aggregate's current version
3. append inside a short transaction
4. treat `store.ErrOptimisticConcurrency` as a normal business race, not as a mysterious infrastructure problem

## Mapping domain events with `eventmap-gen`

Manually maintaining event type strings, payload marshalling, payload unmarshalling, and version dispatch gets old quickly. It is also easy to make avoidable mistakes. A typo in `"OrderConfirmed"` or a forgotten branch in a string-based switch will usually show up much later than you want.

This is why `eventsalsa/store` ships `eventmap-gen`. It generates the mapping code between your domain event structs and `store.Event` / `store.PersistedEvent`.

That buys you two things at once:

- you keep domain events as plain Go types in the domain layer
- you stop hand-writing repetitive mapping code in the infrastructure layer

It also lets you switch on concrete Go types after decoding, which is usually easier to refactor and harder to get wrong than a large string switch.

### Install it as a Go tool

If you want the generator available to the project, add it as a tool dependency:

```bash
go get -tool github.com/eventsalsa/store/cmd/eventmap-gen
```

That gives you a stable project-local way to run it with `go tool eventmap-gen`.

### Drive it through `go generate`

One clean pattern is to keep the code generation directive in the infrastructure package that owns the generated code:

```go
package persistence

//go:generate go tool eventmap-gen -input ../../../domain/order/events -output . -package persistence
```

From there, `go generate ./...` will regenerate the mapping code whenever the event set changes.

:::tip
Keep both the `go:generate` directive and the generated file in the infrastructure layer of your application.

The domain layer should own the event structs themselves, but it should not need to import store-specific code. `eventmap-gen` exists so that infrastructure concerns stay in infrastructure.
:::

### What the generator produces

The generated package includes generic helpers such as:

- `EventTypeOf(...)`
- `ToESEvents(...)`
- `FromESEvent(...)`
- `FromESEvents(...)`

It also emits per-event helpers such as `ToOrderPlacedV1(...)` and `FromOrderPlacedV1(...)`.

That gives you a clean write-side mapping:

```go
events, err := orderes.ToESEvents(
	"Order",
	orderID,
	[]any{
		orderv1.OrderPlaced{CustomerID: "cust_42", Currency: "EUR"},
		orderv1.OrderLineAdded{SKU: "sku-coffee-grinder", Quantity: 1, UnitPriceCents: 12900},
	},
	orderes.WithTraceID(traceID),
	orderes.WithCorrelationID(correlationID),
	orderes.WithCausationID(commandID),
)
```

And it gives you a type-safe read-side mapping:

```go
domainEvent, err := orderes.FromESEvent(event)
if err != nil {
	return err
}

switch e := domainEvent.(type) {
case orderv1.OrderPlaced:
	// work with the concrete Go type
case orderv1.OrderLineAdded:
	// work with the concrete Go type
default:
	return fmt.Errorf("unexpected order event %T", e)
}
```

### Version detection

`eventmap-gen` also detects event versions from your package layout. If your domain events live under versioned directories such as `v1`, `v2`, and so on, the generator will emit the matching `EventVersion` value automatically.

For example:

```text
internal/domain/order/events/
  v1/
    order_placed.go
    order_line_added.go
    order_confirmed.go
  v2/
    order_placed.go
```

Events in `events/v1/` become `EventVersion: 1`. Events in `events/v2/` become `EventVersion: 2`. If no version directory is present, the default is version `1`.

:::tip
Version events from day one.

Even if your first release only has `v1`, the explicit directory makes the intent obvious and keeps future schema evolution boring instead of dramatic.
:::

## Configuring the store

The PostgreSQL implementation lives in `github.com/eventsalsa/store/postgres`. Most applications can start with `postgres.DefaultStoreConfig()`, but the component also exposes a small set of configuration options when you need to tailor table names, notifications, or logging.

```go
config := postgres.NewStoreConfig(
	postgres.WithEventsTable("events"),
	postgres.WithAggregateHeadsTable("aggregate_heads"),
	postgres.WithNotifyChannel("eventsalsa_events"),
	postgres.WithLogger(ZapLogger{logger: zapLogger}),
)

eventStore := postgres.NewStore(config)
```

Here is what each option controls:

| Option | Meaning | When to change it |
| --- | --- | --- |
| `WithEventsTable(...)` | Sets the event log table name. | Rename when your schema conventions require a different table name. |
| `WithAggregateHeadsTable(...)` | Sets the aggregate head table name used for O(1) version lookups. | Rename when your schema conventions require it. |
| `WithNotifyChannel(...)` | Sends a PostgreSQL `NOTIFY` on successful append. | Useful when consumers wake up through `LISTEN/NOTIFY` instead of polling. |
| `WithLogger(...)` | Plugs in store-level logging. | Useful for operational visibility in production and troubleshooting. |

`WithNotifyChannel(...)` is worth calling out. The notification is emitted inside the append transaction, which means listeners only wake up after the transaction commits. That avoids phantom work on rolled-back writes.

## Reading streams

Reading an aggregate stream is what you do when you want the most accurate view of one aggregate's state. That is the normal path for command handling: load the stream, replay it into an entity, make a decision, and then append new events with an expected version derived from that entity.

It is a good fit for:

- command handling
- invariants that need the aggregate's exact current state
- rebuilding one aggregate for debugging or audit purposes
- partial replays over a known version range

It is **not** a good fit for:

- list pages
- search screens
- dashboards
- reports that need to scan many aggregates at once

Those cases are where read models and projections come in.

### Load one aggregate stream

`ReadAggregateStream` returns the events for one aggregate instance ordered by `aggregate_version`:

```go
tx, err := db.BeginTx(ctx, nil)
if err != nil {
	return err
}
defer tx.Rollback() //nolint:errcheck

stream, err := eventStore.ReadAggregateStream(ctx, tx, "Order", orderID, nil, nil)
if err != nil {
	return err
}

if err := tx.Commit(); err != nil {
	return err
}
```

The version bounds are optional and inclusive. That is useful when you want to replay a slice of history instead of the whole stream:

```go
fromVersion := int64(5)
toVersion := int64(9)

stream, err := eventStore.ReadAggregateStream(ctx, tx, "Order", orderID, &fromVersion, &toVersion)
```

### Apply the stream with generated helpers

Once you have the stream, replay it into your aggregate. This is where the generated mapping helpers become especially useful.

```go
package domain

import (
	"fmt"

	"github.com/eventsalsa/store"

	orderv1 "github.com/acme/shop/internal/domain/order/events/v1"
	orderes "github.com/acme/shop/internal/infrastructure/order/persistence/generated"
)

type Order struct {
	ID         string
	CustomerID string
	Currency   string
	Status     string
	LineCount  int
	TotalCents int64
	Version    int64
}

func (o *Order) Apply(event store.PersistedEvent) error {
	domainEvent, err := orderes.FromESEvent(event)
	if err != nil {
		return err
	}

	switch e := domainEvent.(type) {
	case orderv1.OrderPlaced:
		o.ID = event.AggregateID
		o.CustomerID = e.CustomerID
		o.Currency = e.Currency
		o.Status = "pending"

	case orderv1.OrderLineAdded:
		o.LineCount += e.Quantity
		o.TotalCents += int64(e.Quantity) * e.UnitPriceCents

	case orderv1.OrderConfirmed:
		o.Status = "confirmed"

	default:
		return fmt.Errorf("unexpected order event %T", e)
	}

	o.Version = event.AggregateVersion
	return nil
}
```

That is the kind of switch you usually want. It is based on exact Go types, not on hand-maintained strings.

When business logic needs a precise, authoritative state snapshot, replaying the aggregate stream is the safe place to stand. For broad query workloads, however, rebuilding many aggregates on demand is usually the wrong tool.

## Projections and read models

A projection is the process that reads events and keeps some query-friendly structure up to date. The thing it maintains is the read model.

That distinction matters because event streams and read models solve different problems:

- the stream is your source of truth for business history
- the read model is shaped for queries such as list, search, filter, and reporting

If someone asks for "all confirmed orders from last week", you probably do not want to rebuild every order stream at request time. You want a read model that already has the relevant fields arranged for that query.

In store terms, projections usually consume the global log through `ReadEvents`, either directly in your own runtime or through [`eventsalsa/worker`](../worker/).

### A global projection

A global projection is just a consumer that does **not** scope itself to specific aggregate types. That is useful for cross-cutting concerns such as metrics, audit summaries, or integration publishing.

Here is a simple metrics projection. It receives the full log, but in this example it only counts `Order` events:

```go
type OrderMetricsProjection struct{}

func (p *OrderMetricsProjection) Name() string {
	return "order_metrics_v1"
}

func (p *OrderMetricsProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	if event.AggregateType != "Order" {
		return nil
	}

	domainEvent, err := orderes.FromESEvent(event)
	if err != nil {
		return err
	}

	var metricName string

	switch domainEvent.(type) {
	case orderv1.OrderPlaced:
		metricName = "orders_placed_total"
	case orderv1.OrderConfirmed:
		metricName = "orders_confirmed_total"
	default:
		return nil
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO order_metrics_v1 (metric_name, metric_value)
		VALUES ($1, 1)
		ON CONFLICT (metric_name)
		DO UPDATE SET metric_value = order_metrics_v1.metric_value + 1
	`, metricName)
	return err
}
```

Because this projection does not implement `AggregateTypes()`, it is global from the runtime's point of view. That is a good default when you want system-level counters or other cross-cutting views.

### A scoped projection

When a projection only cares about one aggregate family, implement `consumer.ScopedConsumer` and return the aggregate types you want.

For an orders list page, a read model might look like this:

```sql
CREATE TABLE order_overview_v1 (
    order_id     TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    status       TEXT NOT NULL,
    currency     TEXT NOT NULL,
    total_cents  BIGINT NOT NULL,
    line_count   INTEGER NOT NULL,
    version      BIGINT NOT NULL
);
```

The projection that keeps it current can stay focused on `Order` events:

```go
type OrderOverviewProjection struct{}

func (p *OrderOverviewProjection) Name() string {
	return "order_overview_v1"
}

func (p *OrderOverviewProjection) AggregateTypes() []string {
	return []string{"Order"}
}

func (p *OrderOverviewProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	domainEvent, err := orderes.FromESEvent(event)
	if err != nil {
		return err
	}

	switch e := domainEvent.(type) {
	case orderv1.OrderPlaced:
		_, err = tx.ExecContext(ctx, `
			INSERT INTO order_overview_v1 (
				order_id,
				customer_id,
				status,
				currency,
				total_cents,
				line_count,
				version
			)
			VALUES ($1, $2, 'pending', $3, 0, 0, $4)
			ON CONFLICT (order_id) DO UPDATE
			SET customer_id = EXCLUDED.customer_id,
			    status = EXCLUDED.status,
			    currency = EXCLUDED.currency,
			    version = EXCLUDED.version
			WHERE order_overview_v1.version < EXCLUDED.version
		`, event.AggregateID, e.CustomerID, e.Currency, event.AggregateVersion)
		return err

	case orderv1.OrderLineAdded:
		_, err = tx.ExecContext(ctx, `
			UPDATE order_overview_v1
			SET total_cents = total_cents + $2,
			    line_count = line_count + $3,
			    version = $4
			WHERE order_id = $1
			  AND version < $4
		`, event.AggregateID, int64(e.Quantity)*e.UnitPriceCents, e.Quantity, event.AggregateVersion)
		return err

	case orderv1.OrderConfirmed:
		_, err = tx.ExecContext(ctx, `
			UPDATE order_overview_v1
			SET status = 'confirmed',
			    version = $2
			WHERE order_id = $1
			  AND version < $2
		`, event.AggregateID, event.AggregateVersion)
		return err

	default:
		return nil
	}
}
```

The `version` column is what keeps this projection idempotent. If the same event is replayed or retried, the update is ignored once the row has already reached that aggregate version.

### Strong consistency in the repository

If the read model is cheap to update and you need it to be fresh immediately after the command commits, run the projection inside the same transaction as the append.

That turns the repository adapter from earlier into a strongly consistent write path:

```go
result, err := r.eventStore.Append(ctx, tx, expected, events)
if err != nil {
	return err
}

for _, event := range result.Events {
	if err := r.orderOverview.Handle(ctx, tx, event); err != nil {
		return err
	}
}

if err := tx.Commit(); err != nil {
	return err
}
```

This is a strong consistency story in the plain sense of the term: once the transaction commits, both the event stream and the `order_overview_v1` row describe the same change set.

That is a good fit for read models that are:

- quick to update
- local to the same database transaction
- needed immediately by the next request or redirect

### Eventual consistency and `eventsalsa/worker`

Not every projection belongs in the write transaction.

When the projection is expensive, touches outside systems, fans out to many destinations, or simply needs to scale separately from the command path, eventual consistency is usually the better choice. In that model, the append commits first and the projection catches up afterward.

That is where [`eventsalsa/worker`](../worker/) comes in. The projection logic can stay largely the same, but the runtime moves out of the request path and processes the global log asynchronously.

As a rule of thumb:

- choose **strong consistency** for lightweight read models that should be fresh immediately
- choose **eventual consistency** for heavier projections, integrations, search indexing, analytics, and other work that does not belong on the command's critical path

:::note
Read models maintained by projections are for query workloads.

Use aggregate stream reads when you need one aggregate's exact state for business logic. Use read models when you need list screens, filters, reporting, search, or anything else that spans many aggregates.
:::

## Observability

The store keeps observability deliberately simple. It exposes a small logger interface, and it gives you enough primitives to measure projection freshness from the outside.

### Logging store operations

`eventsalsa/store` accepts a `store.Logger`. If you already standardize on Zap, the adapter can stay small:

```go
type ZapLogger struct {
	logger *zap.Logger
}

func (l ZapLogger) Debug(_ context.Context, msg string, keyvals ...interface{}) {
	l.logger.Debug(msg, zapFields(keyvals)...)
}

func (l ZapLogger) Info(_ context.Context, msg string, keyvals ...interface{}) {
	l.logger.Info(msg, zapFields(keyvals)...)
}

func (l ZapLogger) Error(_ context.Context, msg string, keyvals ...interface{}) {
	l.logger.Error(msg, zapFields(keyvals)...)
}

func zapFields(keyvals []interface{}) []zap.Field {
	fields := make([]zap.Field, 0, len(keyvals)/2)
	for i := 0; i+1 < len(keyvals); i += 2 {
		key, ok := keyvals[i].(string)
		if !ok {
			continue
		}
		fields = append(fields, zap.Any(key, keyvals[i+1]))
	}
	return fields
}
```

That is enough for append, read, and concurrency-conflict logs to show up in the same logging pipeline as the rest of the application.

### Tracking projection lag

If you run projections inline, lag is effectively zero because the projection is updated before the transaction commits.

If you run projections asynchronously, lag is one of the first things worth measuring. It tells you how far behind the read side is from the current event log. If lag keeps growing, your read models are getting staler and a consumer may be overloaded or stuck.

One practical way to measure it is:

1. read the latest visible global position from the store
2. compare it with the projection's last processed position from your checkpoint storage

For example:

```go
func ProjectionLag(ctx context.Context, tx *sql.Tx, eventStore store.GlobalPositionReader, projectionName string) (int64, error) {
	latest, err := eventStore.GetLatestGlobalPosition(ctx, tx)
	if err != nil {
		return 0, err
	}

	var checkpoint sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT last_processed_position
		FROM projection_checkpoint
		WHERE projection_name = $1
	`, projectionName).Scan(&checkpoint)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}

	if !checkpoint.Valid {
		return latest, nil
	}

	lag := latest - checkpoint.Int64
	if lag < 0 {
		return 0, nil
	}

	return lag, nil
}
```

If you later move to [`eventsalsa/worker`](../worker/), the same idea still applies: compare the latest available position with the runtime's persisted checkpoint and alert when the distance grows beyond what your system considers healthy.

## Migration generation

The quickest way to create the store schema is still `migrate-gen`:

```bash
go run github.com/eventsalsa/store/cmd/migrate-gen -output migrations
```

That command writes a PostgreSQL migration for the event log and aggregate heads table. You can also set a stable file name:

```bash
go run github.com/eventsalsa/store/cmd/migrate-gen -output migrations -filename 001_event_store.sql
```

If you want to change the generated events table name from the CLI, that flag is available too:

```bash
go run github.com/eventsalsa/store/cmd/migrate-gen -output migrations -events-table event_log
```

### Advanced migration generation

The CLI covers the common path. For more control, use the `migrations` package directly:

```go
config := migrations.DefaultConfig()
config.OutputFolder = "db/migrations"
config.OutputFilename = "001_event_store.sql"
config.EventsTable = "event_log"
config.AggregateHeadsTable = "event_log_heads"

if err := migrations.GeneratePostgres(&config); err != nil {
	return err
}
```

This is the better option when you want the migration to match custom table names exactly.

:::caution
If you change the generated table names, change the store configuration too.

`migrations.Config` and `postgres.StoreConfig` need to stay aligned. A migration that creates `event_log` is not useful if the running store is still configured to read and write `events`.
:::

## Best practices

There is no single right way to structure an event-sourced application, but a few habits pay off quickly.

### Keep command transactions short

The store works inside your `*sql.Tx`, which is a strength, but it also means the command path should stay disciplined. CQRS-style command handling usually works best when the transaction is kept as small as possible:

1. load the aggregate
2. decide
3. append
4. update only the read models that truly need strong consistency
5. commit

Long-running work, remote calls, and heavy projection fan-out are better moved out of the write transaction.

### Think about sensitive data early

Event stores are designed to be append-only. That makes them useful, but it also means payload mistakes are hard to undo cleanly later.

If there is any chance that a payload may carry PII, credentials, or other sensitive material, think about that before the event shape spreads through the system. See [`eventsalsa/encryption`](../encryption/) for patterns around envelope encryption, crypto-shredding, and sensitive lookups.

### Separate write and read access

`eventsalsa/store` works especially well with CQRS-style separation of responsibilities. One practical setup is:

- write-side roles that can append to the event store
- read-side roles that can query only the read models
- a clear split between event store tables and query tables

Many teams keep the event store tables and read models logically separated, often with different schemas or at least different database roles. The exact layout is up to your application, but the principle is simple: the write model and the query model usually benefit from different permissions and different operational concerns.

One common arrangement is to keep the store tables under something like `event_store`, the read models under something like `read_models`, and then grant:

- a read/write role to the write side
- a read-only role to query-facing code and reporting paths

### Plan for store growth

High-traffic systems can grow the event log quickly. When that starts to matter, it is worth thinking about partitioning the events table by `global_position` and managing partitions with a tool such as `pg_partman`.

That is outside the default migration, but it is a sensible operational step once retention, vacuum pressure, and index size begin to show up in production planning.
