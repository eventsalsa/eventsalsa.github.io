---
title: Getting started
description: Understand event sourcing and build a first flow with eventsalsa/store.
---

# Why event sourcing feels different

If you come from a CRUD-first application, event sourcing can look upside down at first.

In a traditional relational model, the database row is the source of truth. An `orders` table holds the current state of each order, and every update overwrites that row:

- an order starts as `pending`
- later it becomes `confirmed`
- then it becomes `shipped`

At any given moment you can see the latest state, but the path that got you there is usually scattered across audit tables, logs, and application code.

Event sourcing turns that around. Instead of storing only the latest state, you store the sequence of facts that happened to an aggregate over time. You can think of it like a bank statement. A bank statement does not tell you only the balance on the account. It shows the deposits, withdrawals, fees, and transfers that explain how the balance came to be.

That is the practical shift: state is derived from history rather than history being inferred from state.

## A practical order example

Imagine an order in a typical CRUD application.

You might have a table like this:

| id | customer_id | status | total_cents |
| --- | --- | --- | --- |
| `ord_123` | `cust_42` | `confirmed` | `34800` |

When something changes, you update the row:

- the customer adds a line item, so `total_cents` changes
- the order is confirmed, so `status` changes
- the address is updated, so one or more columns change

That model is simple and works well for many systems. The trade-off is that the database row tells you what the order looks like now, not what happened to it.

With event sourcing, the order is represented by a stream of events instead:

- `OrderPlaced`
- `OrderLineAdded`
- `OrderLineAdded`
- `OrderConfirmed`

Each event says something that happened. It does not try to store the entire order snapshot every time. To know the current state of the order, you read the stream and apply those events in order.

That has a few consequences:

1. The write side becomes explicit. Commands produce facts.
2. The history of the aggregate is first-class, not an afterthought.
3. The current state is still available, but it is reconstructed from the stream or projected into a read model.

This is why event sourcing often fits domains where business history matters: orders, payments, subscriptions, ledgers, approvals, inventory movement, and similar workflows where “what happened” is at least as important as “what is true now.”

## “How do I list orders?”

This is usually the first practical question.

If orders are stored as appended events, how do you do something ordinary like:

- list all orders
- search orders by customer
- show confirmed orders from last week

You generally do **not** answer those queries by scanning and rebuilding every order stream on demand. That would make simple reads unnecessarily expensive.

Instead, you maintain **read models**. For example, you might keep an `order_overview_v1` table with one row per order containing the fields needed for screens, reports, and search.

To keep that read model up to date, you need a process that reads events and updates the query-friendly structure. That process is called a **projection**.

That gives you two distinct concerns:

- the **event stream**, which is the source of truth for business history
- the **read model**, which is optimized for queries

This guide focuses on the event store first. Later, it also shows an inline projection so you can see how the query side is maintained without introducing more moving parts than necessary.

# Build a first flow with `eventsalsa/store`

For the rest of this guide, the running example is an `Order` aggregate. We will keep the code concrete, but the goal is understanding, not cleverness.

## Install the packages

Start with the event store itself and a PostgreSQL driver:

```bash
go get github.com/eventsalsa/store
go get github.com/lib/pq
```

`eventsalsa/store` is PostgreSQL-backed. The store API is transaction-first, so you stay in control of how database work is grouped and committed.

## Generate the SQL migration

Before you can append events, you need the event store tables.

`eventsalsa/store` ships a small CLI that writes the SQL migration file for you:

```bash
go run github.com/eventsalsa/store/cmd/migrate-gen -output migrations
```

That command writes a timestamped SQL file into `migrations/`. If you want a stable filename, you can set it explicitly:

```bash
go run github.com/eventsalsa/store/cmd/migrate-gen \
  -output migrations \
  -filename 001_events.sql
```

The generated migration creates the append-only `events` table and the `aggregate_heads` table used for efficient version checks during append. Apply that SQL with your normal migration process before moving on.

## Open PostgreSQL and create the store

Once the schema is in place, open a database connection and create the store object:

```go
package main

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq"

	"github.com/eventsalsa/store/postgres"
)

func openStore(ctx context.Context) (*sql.DB, *postgres.Store, error) {
	db, err := sql.Open("postgres", "postgres://postgres:postgres@localhost:5432/eventsalsa?sslmode=disable")
	if err != nil {
		return nil, nil, err
	}

	if err := db.PingContext(ctx); err != nil {
		return nil, nil, err
	}

	storeConfig := postgres.DefaultStoreConfig()
	eventStore := postgres.NewStore(storeConfig)

	return db, eventStore, nil
}
```

`DefaultStoreConfig()` is enough to get started. If you want to customize table names later, `postgres.NewStoreConfig(...)` accepts functional options for that.

## Define the events for the aggregate

The domain events in your application do not need to depend on `eventsalsa/store`. Keep them as plain Go structs that describe what happened:

```go
package order

import "time"

type OrderPlaced struct {
	CustomerID string `json:"customer_id"`
	Currency   string `json:"currency"`
}

type OrderLineAdded struct {
	SKU            string `json:"sku"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
}

type OrderConfirmed struct {
	ConfirmedAt time.Time `json:"confirmed_at"`
}
```

That separation matters. The domain event structs describe business facts. The store event envelope is the infrastructure representation used when those facts are persisted.

## Create store events from those domain events

For this walkthrough, we will build a short order history in one go so you can see several events together. In a real system, these events would often be emitted by separate commands over time.

```go
package main

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/eventsalsa/store"
)

func buildOrderEvents(orderID string) ([]store.Event, error) {
	now := time.Now().UTC()

	placed := OrderPlaced{
		CustomerID: "cust_42",
		Currency:   "EUR",
	}
	lineOne := OrderLineAdded{
		SKU:            "sku-coffee-grinder",
		Quantity:       1,
		UnitPriceCents: 12900,
	}
	lineTwo := OrderLineAdded{
		SKU:            "sku-espresso-cups",
		Quantity:       2,
		UnitPriceCents: 3400,
	}
	confirmed := OrderConfirmed{
		ConfirmedAt: now.Add(2 * time.Minute),
	}

	placedPayload, err := json.Marshal(placed)
	if err != nil {
		return nil, err
	}

	lineOnePayload, err := json.Marshal(lineOne)
	if err != nil {
		return nil, err
	}

	lineTwoPayload, err := json.Marshal(lineTwo)
	if err != nil {
		return nil, err
	}

	confirmedPayload, err := json.Marshal(confirmed)
	if err != nil {
		return nil, err
	}

	events := []store.Event{
		{
			AggregateType: "Order",
			AggregateID:   orderID,
			EventID:       uuid.New(),
			EventType:     "OrderPlaced",
			EventVersion:  1,
			Payload:       placedPayload,
			Metadata:      []byte(`{}`),
			CreatedAt:     now,
		},
		{
			AggregateType: "Order",
			AggregateID:   orderID,
			EventID:       uuid.New(),
			EventType:     "OrderLineAdded",
			EventVersion:  1,
			Payload:       lineOnePayload,
			Metadata:      []byte(`{}`),
			CreatedAt:     now.Add(10 * time.Second),
		},
		{
			AggregateType: "Order",
			AggregateID:   orderID,
			EventID:       uuid.New(),
			EventType:     "OrderLineAdded",
			EventVersion:  1,
			Payload:       lineTwoPayload,
			Metadata:      []byte(`{}`),
			CreatedAt:     now.Add(20 * time.Second),
		},
		{
			AggregateType: "Order",
			AggregateID:   orderID,
			EventID:       uuid.New(),
			EventType:     "OrderConfirmed",
			EventVersion:  1,
			Payload:       confirmedPayload,
			Metadata:      []byte(`{}`),
			CreatedAt:     now.Add(30 * time.Second),
		},
	}

	return events, nil
}
```

Notice what is and is not stored here:

- `EventType` tells consumers how to interpret the payload
- `EventVersion` versions the payload schema
- `AggregateType` and `AggregateID` tell the store which stream this event belongs to

The store will assign `AggregateVersion` and `GlobalPosition` when you append.

## Append the events

Appending is always done inside a SQL transaction:

```go
package main

import (
	"context"
	"database/sql"

	"github.com/google/uuid"

	"github.com/eventsalsa/store"
)

func createOrder(ctx context.Context, db *sql.DB, eventStore store.EventStore) error {
	orderID := uuid.NewString()

	events, err := buildOrderEvents(orderID)
	if err != nil {
		return err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	_, err = eventStore.Append(ctx, tx, store.NoStream(), events)
	if err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	return nil
}
```

The important part here is `store.NoStream()`. It says: _this order must not exist yet_. That is how the first append for a new aggregate is protected.

When you append later events to an existing order, you normally use `store.Exact(currentVersion)` instead. That turns version checking into an explicit part of your write model instead of an accidental race.

## Read the stream back

Reading a stream is straightforward. You ask for one aggregate by type and ID:

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

That returns the complete ordered history for the order. You can also read only part of the stream by version range:

```go
fromVersion := int64(2)
toVersion := int64(4)

stream, err := eventStore.ReadAggregateStream(ctx, tx, "Order", orderID, &fromVersion, &toVersion)
```

That is useful when you want to inspect a slice of history, compare changes across versions, or replay only a known window.

## Rebuild the aggregate from the stream

A stream becomes useful when you apply it back into an aggregate.

Here is a simple `Order` aggregate rebuilt from the event history:

```go
package main

import (
	"encoding/json"

	"github.com/eventsalsa/store"
)

type Order struct {
	ID         string
	CustomerID string
	Currency   string
	Status     string
	TotalCents int64
	Version    int64
	LineCount  int
}

func LoadOrder(stream store.Stream) (*Order, error) {
	order := &Order{}

	for _, event := range stream.Events {
		switch event.EventType {
		case "OrderPlaced":
			var data OrderPlaced
			if err := json.Unmarshal(event.Payload, &data); err != nil {
				return nil, err
			}

			order.ID = event.AggregateID
			order.CustomerID = data.CustomerID
			order.Currency = data.Currency
			order.Status = "pending"

		case "OrderLineAdded":
			var data OrderLineAdded
			if err := json.Unmarshal(event.Payload, &data); err != nil {
				return nil, err
			}

			order.LineCount += data.Quantity
			order.TotalCents += int64(data.Quantity) * data.UnitPriceCents

		case "OrderConfirmed":
			order.Status = "confirmed"
		}

		order.Version = event.AggregateVersion
	}

	return order, nil
}
```

That is the core mental model of event sourcing in practice. The stream is the history. The aggregate is the result of applying that history.

## Maintain a read model inline

Earlier we looked at the question “how do I list orders?” This is where projections come in.

For a simple query screen, you probably do not want to rebuild every order stream whenever someone opens the orders page. Instead, you maintain a read model shaped for that query.

For this guide, the read model is a single table:

```sql
CREATE TABLE order_overview_v1 (
    order_id      TEXT PRIMARY KEY,
    customer_id   TEXT NOT NULL,
    status        TEXT NOT NULL,
    currency      TEXT NOT NULL,
    total_cents   BIGINT NOT NULL,
    line_count    INTEGER NOT NULL,
    version       BIGINT NOT NULL
);
```

This table is not the source of truth. It is a projection of the event stream, optimized for reads.

### Define the projection

`eventsalsa/store` exposes consumer contracts through `github.com/eventsalsa/store/consumer`. A projection is simply a consumer that writes to a read model.

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/eventsalsa/store"
	"github.com/eventsalsa/store/consumer"
)

type OrderOverviewProjection struct{}

func (p *OrderOverviewProjection) Name() string {
	return "order_overview_v1"
}

func (p *OrderOverviewProjection) AggregateTypes() []string {
	return []string{"Order"}
}

func (p *OrderOverviewProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	switch event.EventType {
	case "OrderPlaced":
		var data OrderPlaced
		if err := json.Unmarshal(event.Payload, &data); err != nil {
			return err
		}

		_, err := tx.ExecContext(ctx, `
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
		`, event.AggregateID, data.CustomerID, data.Currency, event.AggregateVersion)
		return err

	case "OrderLineAdded":
		var data OrderLineAdded
		if err := json.Unmarshal(event.Payload, &data); err != nil {
			return err
		}

		_, err := tx.ExecContext(ctx, `
			UPDATE order_overview_v1
			SET total_cents = total_cents + $2,
			    line_count = line_count + $3,
			    version = $4
			WHERE order_id = $1
			  AND version < $4
		`, event.AggregateID, int64(data.Quantity)*data.UnitPriceCents, data.Quantity, event.AggregateVersion)
		return err

	case "OrderConfirmed":
		_, err := tx.ExecContext(ctx, `
			UPDATE order_overview_v1
			SET status = 'confirmed',
			    version = $2
			WHERE order_id = $1
			  AND version < $2
		`, event.AggregateID, event.AggregateVersion)
		return err
	}

	return nil
}

var _ consumer.ScopedConsumer = (*OrderOverviewProjection)(nil)
```

The `version` column is what makes this projection idempotent. If the same event is applied twice, the second run does not advance the row because the stored version is already equal to or higher than the incoming `AggregateVersion`.

### Run it inline with the append

If you run that projection inside the same transaction as the append, the event write and the read model update succeed or fail together:

```go
projection := &OrderOverviewProjection{}

tx, err := db.BeginTx(ctx, nil)
if err != nil {
	return err
}
defer tx.Rollback() //nolint:errcheck

result, err := eventStore.Append(ctx, tx, store.NoStream(), events)
if err != nil {
	return err
}

for _, event := range result.Events {
	if err := projection.Handle(ctx, tx, event); err != nil {
		return err
	}
}

if err := tx.Commit(); err != nil {
	return err
}
```

That pattern gives you strong consistency: once the transaction commits, both the event stream and the `order_overview_v1` row reflect the same change set.

For a first system, that is often the simplest way to introduce projections. You keep the write model explicit, you get a query-friendly table, and you do not need extra infrastructure to understand the pattern.

## Where to go next

Once the first flow makes sense, the next useful chapters are:

- [Store](../components/store/) for append semantics, event mapping generation, stream reads, projections, configuration, and operational guidance
- [Worker](../components/worker/) when you want to move projections into an eventually consistent async runtime
- [Encryption](../components/encryption/) before sensitive payload data starts becoming a liability

That sequence tends to match how real systems grow: first get the write model right, then scale the read side, then harden the event payload story before it becomes painful to change.
