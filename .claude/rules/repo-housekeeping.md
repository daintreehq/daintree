---
paths:
  - ".gitignore"
  - ".daintree/**"
  - ".husky/**"
  - "AGENTS.md"
  - "GEMINI.md"
  - "CLAUDE.md"
  - ".claude/rules/**"
---

# Repo housekeeping

- `AGENTS.md` and `GEMINI.md` point to `CLAUDE.md`. Update `CLAUDE.md`, not those.
- `CLAUDE.md` holds only what every session needs; anything tied to a file area goes in a path-scoped rule here.
- Prettier 3 reads `.gitignore`, so editing it changes which files `format:check` covers.
