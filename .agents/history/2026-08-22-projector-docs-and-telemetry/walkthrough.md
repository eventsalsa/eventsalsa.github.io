# Walkthrough - eventsalsa/projector Upgrade & Consumer Purge

The documentation and website for **eventsalsa** have been updated to reflect the latest upstream architecture across `eventsalsa/store` and `eventsalsa/projector`.

---

## Key Changes

### 1. Component Renaming: `eventsalsa/worker` → `eventsalsa/projector`
- Replaced all references to `eventsalsa/worker` with `eventsalsa/projector`.
- Renamed the documentation file and route from `worker.md` (`/documentation/components/worker/`) to [`projector.md`](src/content/docs/documentation/components/projector.md) (`/documentation/components/projector/`).
- Updated the Starlight sidebar in [`astro.config.mjs`](astro.config.mjs).
- Updated landing page feature cards, quickstart sections, and code examples in [`src/pages/index.astro`](src/pages/index.astro).
- Updated component cards in [`src/content/docs/documentation/index.mdx`](src/content/docs/documentation/index.mdx).

### 2. Consumer Purge & Inline Projections in Store Documentation
- Removed all obsolete references to `consumer.Consumer`, `consumer.ScopedConsumer`, and `github.com/eventsalsa/store/consumer` in [`src/content/docs/documentation/components/store.md`](src/content/docs/documentation/components/store.md) and [`src/content/docs/documentation/getting-started.md`](src/content/docs/documentation/getting-started.md).
- Reframed read model documentation around **inline projections** for strong consistency within command transactions (`Name() string` and `Handle(ctx context.Context, tx pgx.Tx, event store.PersistedEvent) error`).
- Added guidance explaining how designing handlers with `Name()` and `Handle(...)` ensures seamless future compatibility with `eventsalsa/projector` when scaling to asynchronous processing.
- **Removed the legacy "Tracking projection lag" SQL query section** from `store.md`.

### 3. Comprehensive Projector & Telemetry Documentation
- Documented the canonical `projector.Projection` interface:
  ```go
  type Projection interface {
      Name() string
      Handle(ctx context.Context, tx pgx.Tx, event store.PersistedEvent) error
  }
  ```
- Documented dynamic stream and event filtering decorators (`projector.FilterStreamTypes` and `projector.FilterEventTypes`).
- Documented metadata tables (`projector_instances`, `projection_assignments`, `projection_checkpoints`, `projection_gap_skips`, `projector_leader_leases`) and the `migrate-gen` CLI.
- Added the **Observability and telemetry** chapter with the pluggable `projector.Observer` interface, telemetry data structures (`BatchStats`, `DaemonStats`, `GapStats`), helpers (`NoopObserver`, `MultiObserver`), and the complete Prometheus metrics recipe (`PrometheusObserver`).

### 4. Cross-Document Alignment & Actual Component Version Changelog
- Updated [`src/content/docs/documentation/components/encryption.md`](src/content/docs/documentation/components/encryption.md) references to `eventsalsa/projector`.
- Aligned [`src/content/docs/documentation/project/changelog.md`](src/content/docs/documentation/project/changelog.md) with all released tags:
  - `eventsalsa/store`: added **v0.2.0** (removal of consumer interfaces).
  - `eventsalsa/projector`: added **v0.3.0** (observer & telemetry) and **v0.2.0** (projection interface & filtering decorators, store v0.2.0 upgrade).
  - `eventsalsa/encryption`: verified up to **v0.0.4**.
- Updated agent rules in [`.agents/rules/docs.instructions.md`](.agents/rules/docs.instructions.md) and skills in [`.agents/skills/eventsalsa-domain-context/SKILL.md`](.agents/skills/eventsalsa-domain-context/SKILL.md).

---

## Verification Results

### Automated Build Verification
Ran `npm run build` using `rtk`:
```bash
rtk npm run build
```
Output:
```
> astro build
[content] Syncing content
[content] Synced content
[types] Generated 422ms
[build] output: "static"
[build] mode: "static"
[build] directory: ./dist/
[build] Collecting build info...
[build] ✓ Completed in 489ms.
[build] Building static entrypoints...
[vite] ✓ built in 811ms
[vite] ✓ built in 131ms
[build] Rearranging server assets...
 generating static routes 
   ├─ /404.html (+6ms) 
   ├─ /index.html (+2ms) 
   ├─ /documentation/index.html (+7ms) 
   ├─ /documentation/components/encryption/index.html (+3ms) 
   ├─ /documentation/components/projector/index.html (+2ms) 
   ├─ /documentation/components/store/index.html (+2ms) 
   ├─ /documentation/getting-started/index.html (+2ms) 
   ├─ /documentation/project/changelog/index.html (+2ms) 
 ✓ Completed in 59ms.
 [starlight:pagefind] Found 8 HTML files.
 [starlight:pagefind] Finished building search index in 59ms.
 [build] 8 page(s) built in 1.59s
 [build] Complete!
```
All routes, static HTML outputs, Pagefind search indexes, and sitemaps were generated successfully with zero errors.
