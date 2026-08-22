# Walkthrough - Document eventsalsa/projector v0.4.0 Updates

This walkthrough summarizes the documentation and changelog updates made for the `eventsalsa/projector` v0.4.0 release.

## Changes

### 1. Projector Component Guide (`src/content/docs/documentation/components/projector.md`)

- **Full Configuration & Functional Options Table**:
  - Added `projector.WithShutdownTimeout(5*time.Second)` to the full configuration code example.
  - Added `WithShutdownTimeout(d)` with default `5s` to the configuration options reference table.

- **Multi-Daemon and `errgroup` Lifecycle Coordination**:
  - Added `## Running multiple domain daemons (errgroup)` section detailing the runtime semantics for modular monoliths and multi-context services:
    - Clean shutdown: `daemon.Start(ctx)` returns `nil` when the context is canceled (in both initialization and steady-state loops).
    - Fatal failure propagation: Unrecoverable errors return non-nil to cancel sibling daemons in the group.
    - Graceful batch draining: In-flight batches are granted up to `WithShutdownTimeout` before forced cancellation.
    - State & health inspection: Documented `daemon.IsRunning()` and `daemon.IsLeader()` methods for HTTP `/healthz` and `/readyz` probes.
  - Added complete code recipe for multi-daemon worker processes using `golang.org/x/sync/errgroup`.

- **Multi-Daemon Operational Guidelines**:
  - Documented connection pool sizing formula: `PoolSize_min >= NumDaemons * (1 + MaxConcurrentProjections) + Headroom`.
  - Documented `LeaderStrategyLease` requirement with dedicated lease table names per domain to avoid advisory lock collisions.
  - Documented distinct `NOTIFY` channel configuration to avoid wakeup crosstalk.

### 2. Release Changelog (`src/content/docs/documentation/project/changelog.md`)

- Added `### v0.4.0` under `## eventsalsa/projector` with feature highlights.

## Verification

- Ran `npm run build`: built all 8 static pages and Pagefind search index successfully.
