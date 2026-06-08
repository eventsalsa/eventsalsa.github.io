---
name: eventsalsa-domain-context
description: Use this when writing or restructuring site copy, docs, navigation, or release notes for eventsalsa. It provides the core product context and the guardrail that secondary design exports are not product truth.
---

Use this repository context when a task involves product framing, documentation, copy, or information architecture:

- `eventsalsa` is an event sourcing bundle for Go.
- Current components:
  - `eventsalsa/store`: append-only event store
  - `eventsalsa/worker`: async consumers and projections
  - `eventsalsa/encryption`: envelope encryption for PII and secrets, crypto-shredding for GDPR compliance, and HMAC hashing for sensitive lookups

Important constraints:

1. Treat secondary design exports as visual/template references only.
2. Do not import or paraphrase export-generated product claims as if they were authoritative.
3. If the repository does not yet contain the source material needed for a claim, use placeholders or neutral wording instead of inventing details.
4. Keep structure future-friendly: website messaging, documentation, and changelog/release material should all remain compatible with growth beyond the current three components.
