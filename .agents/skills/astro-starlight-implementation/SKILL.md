---
name: astro-starlight-implementation
description: Use this when implementing, building, or refactoring the eventsalsa website or documentation scaffold in Astro and Starlight.
---

This repository uses Astro for the website and Starlight for documentation. Use this skill to build and refine the public website and docs structure.

### Project Setup and Conventions

1. **Website Routes**: Place custom website pages in `src/pages/` and shared layouts/components in `src/layouts/` and `src/components/`.
2. **Docs Content**: Place Starlight documentation content in `src/content/docs/`, with user-facing documentation under `src/content/docs/documentation/`.
3. **Docs Authoring**: Keep docs authoring in Markdown/MDX and prefer Starlight navigation instead of hand-building custom docs UIs in Astro.
4. **Internal Links**: Use `import.meta.env.BASE_URL` for internal links in Astro pages so GitHub Pages deployments work correctly under the repository subpath.

### Implementation and Styling Guidelines

1. **Static-First**: Keep the site static-first and deployable to GitHub Pages.
2. **Accessibility & Clean Code**: Prefer semantic HTML, accessible interactions, keyboard-friendly navigation, and restrained CSS over decorative complexity.
3. **Product Truth**: Do not invent product content, APIs, guarantees, or workflows. Keep copy neutral and placeholder-friendly if authoritative source material is missing. Treat secondary exports as fallback/visual references only.
4. **Validation & Testing**: 
   - Validate the build locally with `npm run build`.
   - Use Playwright when browser validation or responsive checks are relevant.
