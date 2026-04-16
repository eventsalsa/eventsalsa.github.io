# eventsalsa docs

Website and documentation scaffold for **eventsalsa**, an event sourcing bundle for Go.

## Stack

- **Astro** for the website surface
- **Starlight** for documentation in Markdown/MDX
- **GitHub Pages** for static deployment

## Project structure

```text
.
├── public/                     # Static assets
├── src/
│   ├── content/docs/           # Starlight documentation content
│   ├── layouts/                # Shared Astro layouts for the site
│   └── pages/                  # Custom website pages
├── .github/agents/             # Custom Copilot agents
├── .github/instructions/       # Path-specific Copilot instructions
├── .github/skills/             # Project Copilot skills
└── .github/workflows/          # Pages + Copilot setup workflows
```

## Commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

## Notes

- Product facts and documentation structure should come from the actual project and primary design sources, not from secondary exports.
