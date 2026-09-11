# Agent Extensions

Daintree is an orchestration layer for AI coding agents. Plugins touch MCP in two directions, and the two are easy to confuse:

| Contribution | Who is the MCP client | Who calls the tools | Reaches agents in Daintree's terminals |
| --- | --- | --- | --- |
| `mcpServers` | **Daintree.** It spawns your stdio server and talks to it. | Daintree itself, through the `window.electron.pluginMcp` IPC surface — the in-app Daintree Assistant is its tool consumer; the plugin manager's settings UI starts, restarts and inspects servers | **No.** These tools never appear in the `tools/list` a terminal agent sees. |
| `agentMcp` | **The agent.** Daintree hosts an MCP endpoint on its own loopback listener and serves the tools you register. | Agents running in Daintree's terminals, in projects where the user turned the endpoint on | **Yes** — Claude Code launches today. See [Agent MCP endpoints](#agent-mcp-endpoints). |

If you want an agent in a Daintree terminal to call your tools, you want `agentMcp`. An `mcpServers` contribution cannot do that, however it is configured.

Skills are a third route: the plugin ships markdown skill files that Daintree's own MCP server serves through its `skills.search` / `skills.load` tools. Skills are pure declarative knowledge — prompt snippets, workflow instructions, rubrics — injected into the agent's context on demand. See [Skills](#skills).

None of the three changes which agent CLI runs. A separate contribution point, `contributes.agents` (requires the `agent:register` capability), goes the other direction: it teaches Daintree about a launchable agent CLI it doesn't ship in-tree, so the CLI appears as a named, selectable agent rather than a generic shell. See [Contribution points → Agents](./contribution-points.md#agents--shipped-minimal-tier) for that manifest shape.

## MCP servers

Daintree supervises any MCP server a plugin ships. It spawns the process lazily, manages lifecycle, acts as the server's MCP client, and cleans up on Daintree exit. The server's tools are reachable only through Daintree's `pluginMcp` IPC surface, whose tool consumer is the in-app Daintree Assistant (its code lives in the separate `daintreehq/assistant` repository). They are not bridged into terminal agents; for that, see [Agent MCP endpoints](#agent-mcp-endpoints).

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
| `name` | yes | Display name in Daintree's UI. |
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

**Tool discovery:** Daintree queries each server's tool list lazily as well. The list is fetched on first spawn and cached (invalidated on crash or restart). Discovery is capped and two-tier, so a server that ships with 40 tools does not hand its IPC caller 40 full schemas at once: tier-1 (`pluginMcp.listTools`) returns terse tool summaries, bounded by the `maxToolsPerSession` cap (`clampMaxTools`), and the full JSON schema for a tool is fetched via tier-2 (`pluginMcp.getFullSchema`) only when the caller asks for that tool.

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

Tool definitions consume tokens wherever a model reads them. An MCP server exposing 40 tools, each with a detailed JSON schema description, can easily consume 10–30K tokens of context just to be "available" to the model calling it. The industry has moved toward lazy tool discovery — the plugin-MCP IPC surface does the same — but you should still:

- Keep tool descriptions terse and specific
- Return compact results (a model doesn't need the full database dump — just what answers the question)
- Use `structuredContent` for rich data a UI can render without spending the model's tokens

See [Architecture → MCP supervisor](./architecture.md#mcp-supervisor) for the supervisor's side. The first two points apply harder to an [agent MCP endpoint](#agent-mcp-endpoints), whose whole roster is listed to the agent up front — which is why the host caps it. The third does not: an endpoint's result is always sent as text, and an `outputSchema` adds the same data as `structuredContent` rather than moving it off the model's budget.

## Agent MCP endpoints

An `agentMcp` endpoint is the inbound direction: Daintree hosts an MCP server on its own loopback listener, and agents running in Daintree's terminals call the tools your plugin registers on it. You write no server, pick no port and handle no credentials. The host owns the transport, a per-terminal credential, the project binding and revocation; the plugin supplies the tool roster and the code behind it.

### Manifest

```json
{
  "name": "acme.ledger",
  "capabilities": ["mcp:expose"],
  "contributes": {
    "agentMcp": [
      {
        "id": "ledger",
        "name": "Ledger",
        "description": "Read and record entries in this project's ledger.",
        "mode": "tools"
      }
    ]
  }
}
```

The `mcp:expose` capability is required — the manifest is rejected without it (`mcp_expose_capability_required`). One endpoint per plugin. Field reference and limits are in [Contribution points → Agent MCP endpoints](./contribution-points.md#agent-mcp-endpoints--shipped).

### Registering tools

Bind the roster from `activate()` with [`host.mcp.registerTools`](./host-api.md#mcpregistertools):

```ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  await host.mcp.registerTools("ledger", {
    list_entries: {
      description: "List ledger entries, newest first.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      async execute(args, caller, signal) {
        // `args` is only guaranteed to be a JSON object; validate it yourself.
        const limit = typeof args.limit === "number" ? args.limit : 20;
        // `caller.projectId` is the project the calling terminal belongs to.
        return { entries: await readEntries(caller.projectId, limit, signal) };
      },
    },
  });
}
```

`plugins/sample-project/acme.ledger` is a working project plugin built on this surface.

What the host does with the roster:

- **Lazy activation still applies.** An agent's first `tools/list` or `tools/call` on the endpoint activates the plugin if it has not run yet, and waits briefly for the roster to register.
- **The roster is advertised verbatim.** `tools/list` returns exactly the tools you registered — name, description, `inputSchema`, optional `outputSchema` — and nothing else: no resources, no prompts, no server instructions. Registering again replaces the roster and sends `notifications/tools/list_changed`.
- **Arguments are checked only for shape.** A call whose arguments are not a JSON object is refused by the host; everything else reaches `execute` as the agent sent it. Checking them against `inputSchema` is your job.
- **Results are serialized JSON.** Whatever `execute` returns is `JSON.stringify`-ed (`undefined` becomes `null`) and sent as the tool's text content. With an `outputSchema` the result must also be a JSON object, which is sent as `structuredContent`. A thrown error becomes a tool error carrying its message.
- **Calls are cancellable.** The `signal` aborts on the 60-second timeout, when the agent cancels, when the session closes or the credential is revoked, and when the roster changes under a running call. Pass it on to anything long-running.

### Reaching an agent

Declaring an endpoint exposes nothing. It reaches an agent only when all of these hold:

1. **The endpoint is enabled for the project.** Exposure is its own per-project decision, separate from installing or trusting the plugin, default off, and stored in Daintree's user store — never in the repository. The store and its revocation are built; a user-facing control for it is not yet part of this build. See [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).
2. **Daintree's MCP server is enabled** (Settings → MCP server), because the endpoint is served on that listener.
3. **The plugin is loaded** — enabled, not blocklisted, and for a project plugin, loaded for this project.
4. **The agent is Claude Code, launched after the endpoint was turned on.** Each Claude launch in the project is handed one entry per enabled endpoint in the Daintree-owned `--mcp-config` file it already receives, whether or not the project's Daintree MCP tier is on. Other agent CLIs, the in-app Daintree Assistant, and help sessions are not handed plugin endpoints today.

The agent sees your tools under a server key Daintree derives from the manifest and endpoint ids (`daintree-<manifest>-<endpoint>`, sanitised, and shortened with a hash past 25 characters), so Claude names a tool `mcp__<server key>__<tool>`. Tool names are capped at 32 characters to keep that inside Claude's 64-character limit.

Turning an endpoint off revokes every live credential for it in that project, and running agents lose the tools on their next request. Unloading the plugin — disable, uninstall, project close, trust revoke, reload — does the same for all its endpoints.

## Skills

Skills are markdown files a plugin contributes. Daintree's built-in MCP server exposes them as tools, so any agent running in Daintree — through a terminal, through the orchestrated assistant, anywhere — can invoke them through the standard MCP protocol. (The `.claude/skills` paths in `SlashCommandService` are an unrelated Claude-native slash-command feature.)

This is the right contribution point when the extension is about **knowledge or instructions** rather than **capabilities**. A TDD workflow skill doesn't need to call APIs — it just tells the agent how to think. A Linear integration, by contrast, needs network access and belongs in an agent MCP endpoint.

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
| Give an agent in a Daintree terminal a new tool that does something | Agent MCP endpoint (`agentMcp`) |
| Give Daintree and its in-app Assistant a tool backed by an existing stdio MCP server | MCP server (`mcpServers`) |
| Teach the agent a methodology or rubric | Skill |
| Let terminal agents reach an external API (Linear, Jira, Sentry) | Agent MCP endpoint, calling the API from your plugin's `main` |
| Provide a checklist or step-by-step | Skill |
| Share knowledge that travels cleanly across projects | Skill |
| Ship a tool with a project, committed to its repository | Agent MCP endpoint — the only one of the three a `scope: "project"` plugin may declare |

Plugins often combine them — for example, a Linear plugin might serve terminal agents its issue tools through an agent MCP endpoint and ship a skill that teaches the agent the team's preferred ticket planning format.

## What Daintree does not do

- Does not provide a "PreToolUse/PostToolUse hook" contribution point, and no contribution intercepts an agent's tool calls: an agent MCP endpoint serves your own tools and never sees the agent's calls to anything else. This is deliberate — it keeps the extension model uniform and reuses the MCP ecosystem.
- Does not proxy a plugin's own MCP server to terminal agents. An `agentMcp` endpoint's tools are registered in-process through the host API; there is no mode that forwards an agent to a server the plugin runs.
- Does not expose a subagent spawning API. Daintree creates parallel agents natively. Plugins that want to coordinate multiple agents use MCP and skills to direct Daintree's orchestration, not a dedicated subagent contribution.
- Does not allow a plugin to replace the agent entirely. Agent providers are configured at the Daintree level (OpenAI-compatible base URLs), not through plugins.
