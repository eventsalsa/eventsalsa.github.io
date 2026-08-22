# Implementation Plan - Document eventsalsa/projector v0.4.0 Updates

Update the eventsalsa documentation to reflect changes introduced in `eventsalsa/projector` v0.4.0.

## User Review Required

No critical breaking changes; documentation is additive and updates existing components and release notes.

## Proposed Changes

### Documentation

#### `src/content/docs/documentation/components/projector.md`
- Add `WithShutdownTimeout` to configuration example and options table.
- Document `errgroup` lifecycle semantics (clean shutdown with `nil` on canceled context, error propagation on fatal failures, graceful batch draining).
- Document multi-daemon worker architecture with code example.
- Document multi-daemon operational considerations (connection pool sizing, lease tables vs advisory locks, distinct NOTIFY channels).
- Document state inspection methods `daemon.IsRunning()` and `daemon.IsLeader()` for `/healthz` and `/readyz` probes.

#### `src/content/docs/documentation/project/changelog.md`
- Add `v0.4.0` entry under `## eventsalsa/projector`.

## Verification Plan

- Run `npm run build` to ensure all documentation pages build with zero errors and search indexes generate properly.
