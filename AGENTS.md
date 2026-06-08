# Agent Instructions

This repository is the website and documentation home for **eventsalsa**, an event sourcing bundle in Go.

## Workspace Tech Stack

- **Stack**: Astro + Starlight.
- **Custom Website Pages**: `src/pages/`
- **Documentation Content**: `src/content/docs/`
- **User-facing Documentation**: `src/content/docs/documentation/`

## Git Workflow & Conventions

We enforce strict git conventions to keep the repository history clean and traceable:

1. **Branching**: If work starts in the `main` branch, always create and check out a new branch before making any changes. Do not commit directly to `main`.
2. **Commit Formatting**: All commits must follow the Conventional Commits specification. Format the first line as `type(scope): summary`.
3. **Commit Body**: Every commit must include a blank line followed by a fuller explanatory body (extended description). Subject-only commits are not allowed.
4. **Multiline Commit Bodies**: When writing a multiline extended description, use multiple `-m` flags (e.g., `git commit -m "title" -m "paragraph 1" -m "paragraph 2"`) rather than raw newlines (`\n`) in the command.

## Development Guidelines

- **Authority**: Do not invent APIs, guarantees, or workflows. If authoritative details about `eventsalsa` components are missing, leave a neutral placeholder.
- **Tone**: Keep documentation chapters in a professional, natural tone. Do not write heading-only code sections; explain snippets before and after they appear.
- **Design exports**: Do not use secondary design exports as product truth for content or information architecture.
- **Validation**: Validate changes with local build and dev commands:
  - `npm install`
  - `npm run dev`
  - `npm run build`

## Workspace Context & Capabilities

Before performing tasks, consult the project configuration files:
- **Rules**: Located under `.agents/rules/` for persistent guidelines and style preferences.
- **Skills**: Located under `.agents/skills/` for domain-specific knowledge and procedures.
