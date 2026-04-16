---
name: astro-starlight-implementation
description: Use this when implementing or refactoring the eventsalsa website or documentation scaffold. It explains how Astro and Starlight are divided in this repository and how to work safely within that split.
---

This repository uses Astro for the website and Starlight for documentation.

Follow these conventions:

1. Put custom website routes in `src/pages/`.
2. Put shared site layouts/components in `src/layouts/` and `src/components/`.
3. Put Starlight documentation content in `src/content/docs/`, with user-facing documentation under `src/content/docs/documentation/`.
4. Keep docs authoring in Markdown/MDX and prefer Starlight navigation instead of hand-building docs UIs in Astro.
5. Use `import.meta.env.BASE_URL` for internal links in Astro pages so GitHub Pages deployments work under the repository path.
6. Prefer minimal, accessible, static-first implementations unless the task explicitly requires more customization.
7. Validate the scaffold with the repository build command: `npm run build`.
