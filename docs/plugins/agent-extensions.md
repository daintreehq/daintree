# Agent Extensions

Daintree is an orchestration layer for AI coding agents. Plugins extend what those agents can do in two ways:

- **MCP servers** — the plugin ships a Model Context Protocol server. Agents connected to Daintree discover and call its tools.
- **Skills** — the plugin ships markdown skill files that become part of Daintree's own MCP server. Agents access them through the standard MCP connection.

Which you choose depends on what the extension needs to do. MCP servers can run arbitrary code (API calls, shell commands, subprocess orchestration). Skills are pure declarative knowledge — prompt snippets, workflow instructions, rubrics — injected into the agent's context on demand.

Both extend an agent that's already running. A separate contribution point, `contributes.agents` (requires the `agent:register` capability), goes the other direction: it teaches Daintree about a launchable agent CLI it doesn't ship in-tree, so the CLI appears as a named, selectable agent rather than a generic shell. See [Contribution points → Agents](./contribution-points.md#agents--shipped-minimal-tier) for that manifest shape.

## MCP servers

Daintree supervises any MCP server a plugin ships. It spawns the process lazily, manages lifecycle, exposes tools to agents, and cleans up on Daintree exit.

### Manifest

The manifest key is `mcpServers`. It was `experimental_mcpServers` until #10466; the old key is still accepted as a deprecated alias (it parses and runs identically but logs a one-time deprecation warning).

```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "linear",
        "name": "Linear MCP",
        "command": "node",
        "args": ["./dist/mcp/linear-server.js"],
        "env": { "LINEAR_API_KEY": "${settings:linear.apiToken}" }
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Identified at runtime by its `pluginId` + server `id` (the supervisor keys state as `{pluginId} {serverId}`; the IPC surface keys by separate `pluginId`/`serverId` fields). |
| `name` | yes | Display name in the agent's tool list and Daintree UI. |
| `command` | yes | Executable. Relative paths resolve inside the plugin directory. Absolute paths and bare commands (`node`, `python`, `npx`, `uv`) work too. |
| `args` | no | Argv after the command. |
| `env` | no | Environment variables. Values support the `${settings:settingId}` syntax, which resolves at spawn time to the current value of the plugin's **user-scope** setting with that ID (project scope is never read). An unset or `null` setting resolves to an empty string (so the env var stays a valid empty string, not the literal `undefined`); booleans and numbers are stringified, and objects/arrays are JSON-encoded. |

**Intentionally excluded:** remote transports (no `url` field), explicit transport declarations (stdio is inferred from `command`'s presence), per-server working directories, restart policies. Shape deliberately matches the Claude Desktop / Cursor MCP config format — authors shipping the same server as a standalone Claude Desktop extension can copy their config verbatim.

### Lifecycle

Daintree spawns MCP servers **on first tool enumeration**, not at plugin activation. This avoids the well-documented issue where IDEs with many installed MCP servers accumulate subprocesses and leak memory over time.

1. A plugin's MCP servers are registered at plugin load but not spawned.
2. The first `pluginMcp.listTools` (or `pluginMcp.getFullSchema`) call for a server goes through `ensureServerStarted()` (`electron/ipc/handlers/pluginMcp.ts`), which spawns the subprocess, waits for the `initialize` handshake, then returns the tool list / schema.
3. The server stays running. Teardown is keyed by **plugin**, not by any agent session: `PluginMcpSupervisor.shutdown({ pluginId })` runs on plugin unload, and `shutdownAll()` runs on app shutdown.
4. Teardown is execa-managed. The supervisor calls `subprocess.kill()` with no arguments so execa's `forceKillAfterDelay` escalation stays active (passing an explicit signal would disable it). On Windows it additionally shells out to a `taskkill /T /F` tree-kill after `SHUTDOWN_GRACE_MS` to reap stranded grandchildren. There is no hand-sequenced SIGTERM→SIGKILL in the supervisor itself.

**Tool discovery:** Daintree queries each server's tool list lazily as well. The list is fetched on first spawn and cached (invalidated on crash or restart). A server that ships with 40 tools won't dump 40 schemas into the agent's context window unless the agent asks for them — Daintree uses a capped two-tier disclosure: tier-1 (`pluginMcp.listTools`) returns terse tool summaries, bounded by a per-session `maxToolsPerSession` cap (`clampMaxTools`), and the full JSON schema for a tool is fetched lazily via tier-2 (`pluginMcp.getFullSchema`) only when the agent selects it.

**Crash handling:** if a server process dies unexpectedly, the supervisor transitions it to status `crashed`, records `lastError`, invalidates its tool cache, and rejects any pending tool calls (`handleSubprocessExit`, `electron/services/PluginMcpSupervisor.ts`). There is **no** automatic retry or backoff, and no "degraded" state — the status enum is `spawning | ready | crashed | stopped`. Recovery is an explicit manual restart through the `pluginMcp.restart` IPC.

**Secret rotation:** when a **user-scope** setting changes, every currently running server (status `ready` or `crashed`) that references it via `${settings:settingId}` in its `command`, `args`, or `env` is automatically restarted, so the new value is folded in at the next spawn (`PluginMcpSupervisor.notifySettingChanged`, wired from `PluginService.setSettingValueFromUi`/`deleteSettingValueFromUi`). The restart is debounced ~1s so a burst of edits coalesces into one respawn. Servers that were never lazily started are left stopped — a settings change never eagerly boots a server. Project-scope writes are ignored, since `${settings:*}` resolves against user scope only.

### Writing an MCP server for Daintree

MCP servers are standard per the [Model Context Protocol spec](https://modelcontextprotocol.io). Daintree is a standard MCP client. You can use any MCP SDK (TypeScript, Python, Rust) to implement one.

Minimal Node server:

```ts
// dist/mcp/linear-server.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "linear", version: "0.1.0" });

server.registerTool(
  "list_issues",
  {
    description: "List Linear issues assigned to the current user.",
    inputSchema: { state: z.string().optional() },
  },
  async ({ state }) => {
    const issues = await fetchLinear(process.env.LINEAR_API_KEY, state);
    return { content: [{ type: "text", text: JSON.stringify(issues) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

This uses the current `@modelcontextprotocol/sdk` 1.x high-level API (`McpServer` + `registerTool`; the older low-level `new Server(...)` + string-keyed `setRequestHandler("tools/list" | "tools/call", …)` still works but is the verbose path). Note the `.js` extensions on the deep import paths — required under Node's ESM (`NodeNext`) resolution. Daintree speaks the MCP `2025-06-18` protocol version over stdio NDJSON, so any spec-compliant server (any SDK, any language) interoperates.

Bundle with your plugin's Vite build (as a separate entry — MCP servers run in a subprocess, not in Daintree's renderer).

### Cost considerations

Tool definitions consume tokens. An MCP server exposing 40 tools, each with a detailed JSON schema description, can easily consume 10–30K tokens of context just to be "available" to the agent. The industry has moved toward lazy tool discovery — Daintree does the same — but you should still:

- Keep tool descriptions terse and specific
- Return compact results (agents don't need to see the full database dump — just what answers the question)
- Use `structuredContent` for rich data the UI can render at zero token cost to the agent

See [Architecture → MCP supervisor](./architecture.md#mcp-supervisor) for how Daintree mitigates context bloat.

## Skills

Skills are markdown files a plugin contributes. Daintree's built-in MCP server exposes them as tools, so any agent running in Daintree — through a terminal, through the orchestrated assistant, anywhere — can invoke them through the standard MCP protocol. (The `.claude/skills` paths in `SlashCommandService` are an unrelated Claude-native slash-command feature.)

This is the right contribution point when the extension is about **knowledge or instructions** rather than **capabilities**. A TDD workflow skill doesn't need to call APIs — it just tells the agent how to think. A Linear integration, by contrast, needs network access and belongs in an MCP server.

### Manifest

```json
{
  "contributes": {
    "skills": [
      {
        "id": "tdd-workflow",
        "name": "TDD Workflow",
        "path": "./skills/tdd-workflow.md",
        "triggers": ["test-driven", "tdd", "red-green-refactor"]
      }
    ]
  }
}
```

**Fields:**

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. |
| `name` | yes | Human label. |
| `path` | yes | Markdown file, relative to the plugin directory. |
| `triggers` | no | Phrase fragments that help agents discover the skill in Daintree's MCP `skills.search` tool. |

### Skill file format

Skills use a simple frontmatter + markdown body format:

```markdown
---
description: Step-by-step test-driven development workflow.
applies_to:
  - language: typescript
  - language: javascript
  - language: python
---

# TDD Workflow

Follow this sequence for any new feature:

## 1. Red

Write the smallest possible failing test that describes the behavior. Run the test suite — it must fail for the expected reason.

## 2. Green

Write the minimum code needed to make the test pass. Don't refactor yet.

## 3. Refactor

Clean up the code while keeping the test green. Extract helpers, rename for clarity, eliminate duplication.

## When to stop

One feature = one Red-Green-Refactor cycle. Never skip Red — a test that's never seen a failure state isn't a test.
```

**Frontmatter:**

- `description` — one-sentence summary surfaced in skill-discovery results.
- `applies_to` — optional filter hints. Agents use this to decide relevance.
- `examples` — optional list of prompt examples that should invoke this skill.

Everything after the frontmatter is the skill body — the text that gets injected into the agent's context when it invokes the skill.

### How agents invoke skills

Daintree's built-in MCP server exposes two tools for skills:

- `skills.search(query)` — searches ids, names, triggers, and descriptions, returning matching skill IDs and summaries. Omit or pass an empty `query` to list all skills.
- `skills.load(id)` — returns the full markdown body of a specific skill.

Agents use these the same way they'd use any MCP tool. A typical flow:

1. User says "apply TDD to this feature"
2. Agent calls `skills.search("tdd")`
3. Receives a match for `acme.workflows.tdd-workflow` with description
4. Calls `skills.load("acme.workflows.tdd-workflow")`
5. Incorporates the markdown body into its plan

This keeps Daintree's skill system compatible with any agent that speaks MCP — no Daintree-specific prompt engineering needed.

## When to use which

| I want to… | Use |
| --- | --- |
| Give the agent a new tool that does something | MCP server |
| Teach the agent a methodology or rubric | Skill |
| Wrap an external API (Linear, Jira, Sentry) | MCP server |
| Provide a checklist or step-by-step | Skill |
| Do anything that requires secret credentials at runtime | MCP server |
| Share knowledge that travels cleanly across projects | Skill |
| Intercept or modify agent tool calls | MCP server (the plugin's MCP server acts as a proxy) |

Plugins often ship both — for example, a Linear plugin might ship an MCP server that exposes Linear's API and a skill that teaches the agent the team's preferred ticket planning format.

## What Daintree does not do

- Does not provide a "PreToolUse/PostToolUse hook" contribution point. If you need to intercept tool calls, your plugin's MCP server can mediate them. This is deliberate — it keeps the extension model uniform and reuses the MCP ecosystem.
- Does not expose a subagent spawning API. Daintree creates parallel agents natively. Plugins that want to coordinate multiple agents use MCP and skills to direct Daintree's orchestration, not a dedicated subagent contribution.
- Does not allow a plugin to replace the agent entirely. Agent providers are configured at the Daintree level (OpenAI-compatible base URLs), not through plugins.
