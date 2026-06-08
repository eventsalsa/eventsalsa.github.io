---
name: site-qa
description: Use this when validating the eventsalsa website and docs experience in the browser, checking rendering, navigation, responsiveness, and regressions.
---

When validating the built or previewed site in a browser-centric way:

1. **Validation Workflow**: Run the local build or preview server before initiating the browser inspection.
2. **Automated Testing**: Use Playwright against localhost to verify key routes, navigation links, responsiveness, and to check for broken links or visual regressions.
3. **Scope**: Inspect both custom Astro site pages (`src/pages/`) and the Starlight documentation pages (`src/content/docs/`).
4. **Detailed Feedback**: Report concrete failures with route-level details and specific elements instead of generic or vague test summaries.
5. **Contextual Evaluation**: Understand that the current site is an intentionally minimal scaffold. Judge its implementation against structural and functional correctness, rather than finished-brand expectations.
