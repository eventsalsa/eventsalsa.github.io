---
name: docs-structure-and-navigation
description: Use this when creating, maintaining, or reorganizing documentation pages, sidebars, or navigation structure in Starlight.
---

Use this skill when managing Starlight documentation content, information architecture, page structure, frontmatter, and navigation.

### Structure and Navigation Guidelines

1. **Tree Organization**: Keep the documentation tree easy to scan and extend. Favor a stable structure:
   - Overview / Landing
   - Getting started
   - Component-specific pages
   - Project/reference material (e.g., changelog)
2. **Directory Rules**: Keep user-facing documentation content under `src/content/docs/documentation/`.
3. **Sidebar Navigation**: Keep sidebar labels plain, descriptive, and stable. Do not let secondary design exports dictate the documentation IA or routing.

### Documentation Writing and Content Rules

1. **Factual Writing**: Base all documentation on verified repository facts, explicit user instructions, and git/project history.
2. **Speculative Content**: Avoid speculative API descriptions, performance benchmarks, guarantees, or workflows.
3. **Handling Missing Details**: If product information or APIs are incomplete or unknown, preserve the logical page structure and use light, neutral placeholder prose instead of fabricating details.
