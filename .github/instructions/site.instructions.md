---
applyTo: "astro.config.mjs,src/pages/**/*.astro,src/components/**/*.astro,src/layouts/**/*.astro"
---

- The public site uses Astro and should stay static-first unless a task clearly requires more.
- Keep documentation in Starlight content files rather than reimplementing docs pages as custom Astro routes.
- Favor semantic HTML, accessible headings, keyboard-friendly navigation, and restrained styling over decorative complexity.
- New website scaffolding should stay generic until real brand/design work is ready.
- Do not mirror secondary design exports verbatim. The live design source is more authoritative than exported artifacts.
- When linking internally from Astro pages, prefer `import.meta.env.BASE_URL` so Pages deployments remain correct under a repository subpath.
