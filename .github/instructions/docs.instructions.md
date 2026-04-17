---
applyTo: "src/content/docs/**/*.md,src/content/docs/**/*.mdx"
---

- Starlight content in this repository lives under `src/content/docs/`.
- Keep the documentation experience under the `/documentation/` route family by placing user-facing docs in `src/content/docs/documentation/`.
- Prefer plain Markdown unless MDX materially improves structure or navigation.
- Use concise frontmatter with `title` and `description`. Reserve richer frontmatter like splash heroes for landing pages.
- Do not invent behavior or APIs for `eventsalsa/store`, `eventsalsa/worker`, or `eventsalsa/encryption`. If implementation details are unknown, leave a placeholder and keep claims neutral.
- Treat secondary design exports as visual inspiration only, never as a source of product facts or documentation structure.
- Keep documentation aligned with a clear split between overview, getting started, component reference, and project/reference material.
- Write component chapters in a natural, professional tone; avoid formulaic or obviously generated-sounding copy.
- Do not create sections that consist only of a heading and a code block. Explain the purpose and tradeoffs around examples in prose.
- When an example grows large, split it into smaller snippets and add explanatory text between them so the narrative stays easy to follow.
