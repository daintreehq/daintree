# Daintree Help System

Multi-agent help assistant workspace. Runs any supported AI coding agent (Claude Code, Gemini CLI, Codex CLI) in a sandboxed help-assistant mode that answers user questions about Daintree using a live MCP documentation server. Claude additionally connects to a tier-gated local MCP server (`daintree`) that exposes read-only introspection or non-destructive actions on the running Daintree app, depending on the session's authorization tier. Gemini and Codex remain docs-only in Phase 1.

Daintree launches agents in this directory automatically via the help panel — users don't need to `cd` here manually.

## Quick Start

```bash
cd help

claude          # Claude Code
gemini          # Gemini CLI
codex           # Codex CLI
```

Each agent auto-discovers its instruction file and config from the working directory, constrains itself to help-assistant mode, and connects to the `daintree-docs` MCP server for live documentation search.

## Architecture

```
help/
├── CLAUDE.md                  # Claude Code system prompt
├── GEMINI.md                  # Gemini CLI system prompt
├── AGENTS.md                  # Codex CLI system prompt (OpenAI convention)
├── .mcp.json                  # Shared MCP server config (Claude + Codex)
├── .claude/settings.json      # Claude permission lockdown
├── .gemini/settings.json      # Gemini tool allowlist + MCP config
├── .codex/config.toml         # Codex sandbox + MCP config
├── .gitignore                 # Excludes agent caches, sessions, logs
├── docs/
│   └── issue-guidelines.md    # What issues the project accepts/rejects
└── README.md                  # This file
```

## Supported Agents

| Agent       | Command  | System Prompt | Config                                | Permission Model                |
| ----------- | -------- | ------------- | ------------------------------------- | ------------------------------- |
| Claude Code | `claude` | `CLAUDE.md`   | `.claude/settings.json` + `.mcp.json` | Explicit allow/deny lists       |
| Gemini CLI  | `gemini` | `GEMINI.md`   | `.gemini/settings.json`               | Tool allowlist                  |
| Codex CLI   | `codex`  | `AGENTS.md`   | `.codex/config.toml`                  | Full sandbox, no writable roots |

Adding a new agent requires three things:

1. A system prompt file using that agent's convention (e.g., `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`)
2. A config file that scopes the agent's tool surface and connects it to the MCP server(s)
3. An entry in `.gitignore` for any caches or session files the agent creates

## System Prompts

The three prompt files share the same answer workflow, tone, and topic coverage. They diverge on what the assistant is allowed to do beyond docs search:

- **`CLAUDE.md`** — Tier-aware. Describes the `workbench` / `action` / `system` model exposed by the local `daintree` MCP server (see Tier Model below) and tells Claude to prefer the least-privileged path.
- **`AGENTS.md`** (Codex) and **`GEMINI.md`** — Docs-only in Phase 1. No local MCP wiring; the assistant only searches docs and uses `gh` for GitHub issues.

All three share:

- **Answer workflow:** Search the `daintree-docs` MCP first, never fabricate
- **Tone:** Concise, actionable, grounded in documentation
- **Scope boundary:** If a question is outside docs, search GitHub issues or offer to file one
- **GitHub access:** Search/view issues without confirmation; creating issues requires user approval of the draft text and the tool call
- **Topic coverage:** 11 documentation areas (getting started, panels, agents, worktrees, keybindings, actions, context injection, recipes, themes, browser/devpreview, workflows)

## Tier Model

Claude help sessions run at one of three authorization tiers, selected by user settings. The local `daintree` MCP server filters its `ListTools` response and rejects out-of-tier `CallTool` requests with `TIER_NOT_PERMITTED`. Tiers are additive: `action` is `workbench` plus addons, `system` is `action` plus addons.

| Tier        | Trigger                                 | Capabilities (categories)                                                                                                       |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `workbench` | (not exposed to help sessions today)    | Read-only introspection: list projects, worktrees, terminals; read git status, diffs, commits; view GitHub issues/PRs.         |
| `action`    | Default for help sessions               | Adds non-destructive mutations: create worktrees, inject context, run recipes, open files, focus agents.                       |
| `system`    | Help-session skip-permissions setting   | Adds destructive operations: delete worktrees, send raw terminal commands, stage/commit/push git, open issues/PRs, launch agents. |

The authoritative tier definitions live in `electron/services/McpServerService.ts` (`WORKBENCH_TOOLS`, `ACTION_TIER_ADDONS`, `SYSTEM_TIER_ADDONS`). When local MCP is disabled in settings, the `daintree` server is omitted from the per-session `.mcp.json` entirely — Claude falls back to docs-only behavior.

## Permission Lockdown

Claude and Codex block file writes, edits, and arbitrary shell commands at the tool layer; Gemini's `shell` tool is allowlisted but constrained by instruction-level guardrails. All three share a `gh` allowlist for searching/viewing GitHub issues; creating issues always requires user confirmation. Claude additionally has tier-gated access to a local `mcp__daintree__*` tool surface for inspecting and acting on the running Daintree app — Gemini and Codex do not.

**Claude** (`.claude/settings.json`):

- Allows: `Read(**)`, `Glob(**)`, `Grep(**)`, `LS(**)`, `WebFetch`, `mcp__daintree-docs__*`
- Allows (auto-approved): `Bash(gh issue list*)`, `Bash(gh issue view*)`, `Bash(gh issue search*)`, `Bash(gh search issues*)`
- Denies: `Write(**)`, `Edit(**)`, `MultiEdit(**)`, `Bash(**)` (catches `gh issue create`, requiring user confirmation)
- At provision time, `HelpSessionService` adds `mcp__daintree__*` to the allow list when the user has local MCP enabled, and sets `defaultMode: "bypassPermissions"` when skip-permissions is enabled. The session tier (`workbench` / `action` / `system`) gates the actual `mcp__daintree__*` tool surface server-side.

**Gemini** (`.gemini/settings.json`):

- Allowlist: `read_file`, `list_directory`, `search_files`, `web_search`, `shell`
- MCP configured inline with `"trust": true`
- Issue creation requires user confirmation via instruction-level guardrails

**Codex** (`.codex/config.toml`):

- `sandbox = "full"`, `writable_roots = []`, `allowed_commands = ["gh"]`
- Issue creation requires user confirmation via instruction-level guardrails

## MCP Documentation Server

All agents connect to the `daintree-docs` MCP server at `https://daintree.org/api/mcp`. This is an HTTP-based MCP server hosted on the Daintree website that provides live semantic search across all published documentation.

**Tools exposed by the server:**

| Tool                 | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `search`             | Semantic search across all docs (primary tool for answering questions) |
| `get_page`           | Fetch full markdown of a specific page by path/URL                     |
| `list_pages`         | List all indexed documentation pages                                   |
| `get_site_structure` | Hierarchical page tree                                                 |
| `get_related_pages`  | Find related pages for further reading                                 |

All documentation is served exclusively through MCP — there are no bundled fallback docs.

**MCP config locations:**

- Claude and Codex read from the shared `.mcp.json` in the workspace root
- Gemini has MCP configured inline in `.gemini/settings.json`

## How Daintree Launches Help Agents

The main Daintree app launches help agents by spawning the agent CLI process with this directory as the working directory. The agent auto-discovers its config files and enters help mode. From the app side, this is handled by the help panel and `agent.launch` action. The help panel provides a dedicated UI for interacting with the help agent within Daintree itself.

## Maintenance

- **Updating docs:** All documentation is served via the `daintree-docs` MCP server — keep the website docs up-to-date. The only file in `docs/` is `issue-guidelines.md`.
- **Adding an agent:** Create a system prompt file, config file, and `.gitignore` entry following the pattern of existing agents.
- **Testing:** Run any agent command from this directory and ask it questions about Daintree features to verify it responds correctly and stays in help-assistant mode.
