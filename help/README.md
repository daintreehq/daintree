# Daintree Help System

Multi-agent help assistant workspace. Runs any supported AI coding agent (Claude Code, Gemini CLI, Codex CLI) in a sandboxed, read-only mode that answers user questions about Daintree using bundled documentation and a live MCP documentation server.

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
2. A config file that locks the agent to read-only and connects it to the MCP server
3. An entry in `.gitignore` for any caches or session files the agent creates

## System Prompts

All three prompt files (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`) share the same core instructions with minor formatting differences per agent:

- **Role override:** "You are a Daintree help assistant, NOT a general-purpose coding agent"
- **Answer workflow:** Search via MCP (only documentation source), never fabricate
- **Tone:** Concise, actionable, grounded in documentation
- **Scope boundary:** If a question is outside docs, search GitHub issues or offer to file one
- **GitHub access:** Search/view issues without confirmation; creating issues requires user approval of the draft text and the tool call
- **Topic coverage:** 11 documentation areas (getting started, panels, agents, worktrees, keybindings, actions, context injection, recipes, themes, browser/devpreview, workflows)

## Permission Lockdown

Each agent is restricted to read-only operations plus `gh` CLI access for GitHub issues. No file writes, edits, or arbitrary shell commands are permitted.

**Claude** (`.claude/settings.json`):

- Allows: `Read(**)`, `Glob(**)`, `Grep(**)`, `LS(**)`, `WebFetch`, `mcp__canopy-docs__*`
- Allows (auto-approved): `Bash(gh issue list*)`, `Bash(gh issue view*)`, `Bash(gh issue search*)`, `Bash(gh search issues*)`
- Denies: `Write(**)`, `Edit(**)`, `MultiEdit(**)`, `Bash(**)` (catches `gh issue create`, requiring user confirmation)

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
