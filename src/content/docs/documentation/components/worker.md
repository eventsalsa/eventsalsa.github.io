---
title: Worker
description: Run consumers and projections asynchronously with eventsalsa/worker.
---

`eventsalsa/worker` is the asynchronous side of the bundle. It builds on `eventsalsa/store` and gives you a PostgreSQL-native runtime for projections and other consumers: worker registration, leader election, consumer assignment, checkpointing, wakeup dispatching, and batched event processing.

The important idea is that the worker is not a second event store. It is the runtime that reads the store's global log safely and drives consumers forward without needing Redis, ZooKeeper, or a message broker just to coordinate who handles what.

At a practical level, the component covers:

- worker registration and heartbeats in PostgreSQL
- leader election with PostgreSQL advisory locks
- deterministic consumer assignment across live workers
- checkpoint persistence per consumer
- wakeup dispatching through polling or `LISTEN`/`NOTIFY`
- batched transactional event handling
- gap-aware frontier handling so checkpoints advance safely

## Install the worker

Start by adding the module itself:

```bash
go get github.com/eventsalsa/worker
```

In a real application, the worker usually sits next to `github.com/eventsalsa/store` and uses the same PostgreSQL database. That means your database needs both:

- the event-store tables from `eventsalsa/store`
- the worker infrastructure tables from `eventsalsa/worker`

## Generate the worker migration SQL

Unlike `eventsalsa/store`, the worker currently exposes migration generation through a Go package rather than a standalone CLI. That works well in practice because the worker migration has a small, explicit configuration surface.

One straightforward way to generate the SQL is to keep a tiny helper program in your repository:

```go
package main

import (
	"log"

	"github.com/eventsalsa/worker/migrations"
)

func main() {
	config := migrations.DefaultConfig()
	config.OutputFolder = "migrations"
	config.OutputFilename = "002_worker_infrastructure.sql"

	if err := migrations.GeneratePostgres(&config); err != nil {
		log.Fatal(err)
	}
}
```

Run that helper with `go run`, check the generated SQL into your migration flow, and apply it before starting any worker process.

The generated migration creates four tables:

- `worker_nodes`
- `consumer_assignments`
- `consumer_checkpoints`
- `consumer_gap_skips`

Those tables are the worker's control plane. They do not hold domain data; they hold worker liveness, ownership, progress, and stale-gap audit information.

## Minimum example

A minimal worker setup needs three pieces:

1. a database handle
2. an event store implementation
3. one or more consumers

Here is a deliberately small consumer. It uses the same `consumer.Consumer` contract that the store documentation introduced:

```go
type OrderOverviewProjection struct{}

func (p *OrderOverviewProjection) Name() string {
	return "order_overview_v1"
}

func (p *OrderOverviewProjection) AggregateTypes() []string {
	return []string{"Order"}
}

func (p *OrderOverviewProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	_ = ctx
	_ = tx
	_ = event
	return nil
}
```

Once you have a consumer, wiring the worker is mostly about giving it the database, the store, and the consumer list:

```go
package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/lib/pq"

	"github.com/eventsalsa/store/consumer"
	storepostgres "github.com/eventsalsa/store/postgres"
	"github.com/eventsalsa/worker"
)

func main() {
	connStr := os.Getenv("DATABASE_URL")

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	eventStore := storepostgres.NewStore(storepostgres.DefaultStoreConfig())

	consumers := []consumer.Consumer{
		&OrderOverviewProjection{},
	}

	w := worker.New(
		db,
		eventStore,
		consumers,
		worker.WithBatchSize(100),
		worker.WithPollInterval(500*time.Millisecond),
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := w.Start(ctx); err != nil {
		log.Fatal(err)
	}
}
```

`(*worker.Worker).Start(...)` blocks until the context is canceled or the worker hits a fatal runtime error. In other words, this is usually the top-level process in a worker binary, not a helper you call from a request path.

## Full configuration

The worker uses functional options. Most installations only need a few of them, but the runtime exposes enough control to tune batching, wakeups, liveness, and table names.

```go
w := worker.New(
	db,
	eventStore,
	consumers,
	worker.WithBatchSize(200),
	worker.WithBatchPause(100*time.Millisecond),
	worker.WithBatchTimeout(20*time.Second),
	worker.WithMaxConsecutiveFailures(5),
	worker.WithPollInterval(500*time.Millisecond),
	worker.WithMaxPollInterval(10*time.Second),
	worker.WithDispatcherInterval(200*time.Millisecond),
	worker.WithHeartbeatInterval(5*time.Second),
	worker.WithHeartbeatTimeout(30*time.Second),
	worker.WithRebalanceInterval(5*time.Second),
	worker.WithStaleGapThreshold(30*time.Second),
	worker.WithStaleGapHarborLag(8),
	worker.WithDispatcherStrategy(worker.DispatcherStrategyPoll),
	worker.WithLogger(logger),
)
```

For reference, the full option set is:

| Option | Default | Meaning |
| --- | --- | --- |
| `WithBatchSize(n)` | `100` | Maximum number of events probed and handled per batch window. |
| `WithBatchPause(d)` | `200ms` | Pause between consecutive full catch-up batches. |
| `WithBatchTimeout(d)` | `30s` | Maximum duration for one batch transaction. |
| `WithMaxConsecutiveFailures(n)` | `5` | Fatal-failure threshold for repeated batch failures. |
| `WithPollInterval(d)` | `1s` | Base interval for the consumer poll loop. |
| `WithMaxPollInterval(d)` | `30s` | Maximum adaptive poll backoff. |
| `WithDispatcherInterval(d)` | `200ms` | Poll-dispatcher interval used to detect new events. |
| `WithHeartbeatInterval(d)` | `5s` | How often a worker refreshes its heartbeat. |
| `WithHeartbeatTimeout(d)` | `30s` | Age after which a worker is considered stale. |
| `WithRebalanceInterval(d)` | `5s` | How often the leader checks whether assignments need to change. |
| `WithStaleGapThreshold(d)` | `30s` | How long to wait on the same missing global position before safe-harbor advancement. |
| `WithStaleGapHarborLag(n)` | `8` | How far behind the visible head the worker stays when skipping past a stale gap. |
| `WithDispatcherStrategy(strategy)` | `poll` | Wakeup strategy: `poll` or `notify`. |
| `WithNotifyConnectionString(connStr)` | empty | Dedicated PostgreSQL connection string for `LISTEN`/`NOTIFY`. |
| `WithNotifyChannel(channel)` | `worker_events` | Notification channel used by the notify dispatcher. |
| `WithLogger(logger)` | `store.NoOpLogger{}` | Structured logging integration. |
| `WithWorkerNodesTable(name)` | `worker_nodes` | Override worker-registration table name. |
| `WithConsumerAssignmentsTable(name)` | `consumer_assignments` | Override assignment table name. |
| `WithConsumerCheckpointsTable(name)` | `consumer_checkpoints` | Override checkpoint table name. |
| `WithConsumerGapSkipsTable(name)` | `consumer_gap_skips` | Override stale-gap audit table name. |

The rest of this chapter focuses on the settings that change behavior in meaningful ways.

## Batching: throughput, latency, and transaction size

The worker processes events in batches, not one event at a time. That is a big part of why it catches up efficiently, but it also means batching is one of the first tuning levers worth understanding.

### `BatchSize`

`WithBatchSize(...)` controls how many rows the worker probes from the global log at once.

Smaller batches usually mean:

- shorter transactions
- lower blast radius when a batch fails
- less time spent inside one consumer transaction
- more round trips and lower catch-up throughput

Larger batches usually mean:

- better throughput when a projection is far behind
- a wider frontier probe window
- longer transactions
- longer time before one failing batch is retried

There is no universal number here. For read models that do cheap SQL updates, larger batches often work well. For projections that do heavier work, smaller batches are usually friendlier to the database and easier to reason about operationally.

### `BatchPause`

`WithBatchPause(...)` is the short pause between consecutive full windows during catch-up. It is there to keep the worker from becoming an aggressive tight loop when it is chewing through a long backlog.

If you shorten it, catch-up can become more aggressive. If you lengthen it, catch-up becomes gentler but slower.

### `BatchTimeout` and `MaxConsecutiveFailures`

`WithBatchTimeout(...)` caps the time one batch is allowed to spend in-flight. If the batch exceeds that limit, the context is canceled and the transaction is rolled back.

`WithMaxConsecutiveFailures(...)` exists for a different reason: it prevents a worker from looking alive because heartbeats still flow while a consumer is actually stuck failing the same work forever.

Together, those two settings give you a clear runtime stance:

- one batch should not run forever
- repeated failure should eventually be treated as a fatal process-level problem

## Dispatcher strategy

The dispatcher is a wakeup optimization. It nudges consumer loops when new events appear so they do not have to wait for their next poll interval to discover fresh work.

### Poll dispatcher

`worker.DispatcherStrategyPoll` is the default. It periodically checks the latest global position and wakes consumers when it advances.

This is the safest choice when:

- you want the simplest setup
- you run through PgBouncer or a similar proxy
- you do not need the lowest possible wakeup latency

It is also the most forgiving operationally because it does not depend on a dedicated listener connection.

### Notify dispatcher

`worker.DispatcherStrategyNotify` uses PostgreSQL `LISTEN`/`NOTIFY` and also performs reconciliation polling in the background. That gives you lower wakeup latency without trusting notifications blindly.

To use it well, both sides need to agree on the same channel:

- the store append path emits `NOTIFY`
- the worker listens on that channel

```go
eventStore := storepostgres.NewStore(
	storepostgres.NewStoreConfig(
		storepostgres.WithNotifyChannel("worker_events"),
	),
)

w := worker.New(
	db,
	eventStore,
	consumers,
	worker.WithDispatcherStrategy(worker.DispatcherStrategyNotify),
	worker.WithNotifyConnectionString(connStr),
	worker.WithNotifyChannel("worker_events"),
)
```

:::caution
Use the notify dispatcher only when the listener connection preserves PostgreSQL session state.

If your workers connect through PgBouncer in transaction-pooling mode, or through another proxy that does not preserve long-lived session semantics, prefer the poll dispatcher. `LISTEN`/`NOTIFY` is session-oriented, and session-unaware pooling is the wrong place to bet your wakeup path.
:::

## Polling behavior

There are two different kinds of polling in the runtime, and it helps to separate them mentally.

### Consumer polling

`WithPollInterval(...)` and `WithMaxPollInterval(...)` control the consumer loop itself.

The worker starts at the base poll interval, backs off exponentially when it finds no progress, and resets back to the base interval when either:

- new events are found
- a dispatcher wakeup arrives

That gives you a runtime that stays quiet when the system is idle but becomes responsive again as soon as new work appears.

### Dispatcher polling

`WithDispatcherInterval(...)` is different. It belongs to the poll dispatcher and controls how often that dispatcher checks the latest global position.

In other words:

- `PollInterval` is about how each consumer loop idles
- `DispatcherInterval` is about how often the poll dispatcher looks for fresh work

If you use the notify dispatcher, reconciliation polling still exists in the background, but the steady-state wakeup path is notification-driven instead of interval-driven.

## How one worker actually runs

At runtime, one worker process does more than "call Handle in a loop". The lifecycle is roughly:

1. clean up very stale worker registrations on startup as a best-effort housekeeping step
2. register itself in `worker_nodes`
3. ensure consumers and checkpoints exist in the worker metadata tables
4. start the dispatcher
5. participate in leader election using a PostgreSQL advisory lock
6. if elected leader, rebalance consumer ownership across the current live workers
7. start consumer goroutines only for the consumers currently assigned to this worker
8. keep heartbeating until shutdown

That combination is what lets the runtime stay coordinated without an external coordinator.

## Scaling across multiple workers

The scaling model is intentionally simple: one consumer can be processed by one worker at a time.

If you have ten consumers and one worker process, that worker runs all ten. If a second worker joins, the leader recalculates assignments and the consumers are redistributed. In practice that means something close to five consumers on one worker and five on the other. If a third worker joins, the set is rebalanced again.

The assignment is deterministic. The runtime sorts consumer names, sorts live worker IDs, and then assigns consumers round-robin across the live workers. That makes rebalancing predictable and keeps every worker in agreement about the intended distribution.

When a new worker is deployed:

1. it registers and starts heartbeating
2. the leader sees a new live worker during rebalance
3. assignments are recomputed
4. workers stop consumers they no longer own
5. workers start consumers newly assigned to them

This is also why a consumer should be named clearly and stably. Its name is both the checkpoint identity and the assignment identity.

## Gaps, frontiers, and safe progress

This is the part of the worker that matters most for correctness.

The event store's `global_position` is sequence-backed. That means positions are unique and sortable, but commit order is not guaranteed under concurrent writers. A lower position can become visible after a higher one has already been seen.

If a worker advanced a checkpoint naively to "the highest row I just saw", it could skip work permanently.

The runtime avoids that by probing an **unscoped frontier** before it opens the batch transaction:

1. load the current checkpoint
2. read a window of events after that checkpoint
3. compute the longest contiguous prefix from the expected next global position
4. process only that safe frontier
5. save the checkpoint inside the same transaction as the consumer work

That is why scoped consumers still use an unscoped frontier probe under the hood. A scoped consumer may handle zero matching events in a batch and still advance its checkpoint, because the checkpoint tracks the highest **safe** global position, not the last matching event.

### Stale gaps

If the next expected global position is missing, the worker does not immediately skip it. It keeps watching the same gap for up to `StaleGapThreshold`.

If the gap remains unresolved long enough, the worker advances conservatively to a safe harbor behind the visible head and records that decision in `consumer_gap_skips`.

That gives you two useful properties:

- workers do not block forever on a missing row
- operators still get a durable audit trail whenever the runtime decides to move past a stale gap

### Best practices around gaps

Most gap pain starts on the append side, not on the worker side.

The simplest habit that helps is this: keep store append transactions short. The longer a write transaction stays open, the longer a lower global position can remain invisible while higher positions from other transactions keep appearing.

That is why the store chapter leans so hard on short command transactions. It is not only about write throughput. It also makes the read side's frontier behavior much calmer.

## A few operational notes

Before you put the worker in production, a few habits pay off quickly:

- keep consumer names stable; renaming a consumer means changing its checkpoint identity
- use the poll dispatcher by default unless you genuinely need lower wakeup latency
- if you use the notify dispatcher, make sure the listener connection is not routed through transaction pooling
- watch `consumer_gap_skips`; frequent entries are a signal worth investigating
- prefer small, fast `Handle(...)` transactions for read models and push heavier work to separate systems when needed

The worker is at its best when the write path stays disciplined and the projection work stays explicit. In that shape, it scales cleanly and remains understandable when production behavior stops being friendly.
