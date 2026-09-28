# Agent Extensions

Daintree is an orchestration layer for AI coding agents. Plugins touch MCP in two directions, and the two are easy to confuse:

| Contribution | Who is the MCP client | Who calls the tools | Reaches agents in Daintree's terminals |
| --- | --- | --- | --- |
| `mcpServers` | **Daintree.** It spawns your stdio server and talks to it. | Daintree itself, through the `window.electron.pluginMcp` IPC surface — the in-app Daintree Assistant is its tool consumer; the plugin manager's settings UI starts, restarts and inspects servers | **No.** These tools never appear in the `tools/list` a terminal agent sees. |
| `agentMcp` (and `databases`) | **The agent.** Daintree hosts one MCP server per plugin on its own loopback listener and serves the tools you register, beside the host's read-only database tools when the plugin declares a database. | Agents running in Daintree's terminals, in projects where the plugin has agent access: **Read only** for the database tools, **Read and write** for your tools as well | **Yes** — Claude Code, Codex, Gemini CLI, opencode, Copilot CLI, Amp, Qwen Code and Mistral Vibe launches. See [Reaching an agent](#reaching-an-agent). |

If you want an agent in a Daintree terminal to call your tools, you want `agentMcp`; if you only want it to read your plugin's SQLite data, declaring the database is enough. An `mcpServers` contribution cannot do either, however it is configured.

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

See [Architecture → MCP supervisor](./architecture.md#mcp-supervisor) for the supervisor's side. The first two points apply harder to an [agent MCP endpoint](#agent-mcp-endpoints), whose whole roster is listed to the agent up front — which is why the host caps it, at 16 tools. What that costs depends on the client and its configuration: by default Claude Code defers MCP tool schemas behind its built-in tool search once they pass about 10% of the context window, while Codex CLI loads every tool up front unless its tool search is turned on. Loaded eagerly, 16 tools at a typical 250–600 tokens each come to roughly 4–10K tokens. The third does not: an endpoint's result is always sent as text, and an `outputSchema` adds the same data as `structuredContent` rather than moving it off the model's budget.

## Agent MCP endpoints

Daintree serves each plugin to the agents in its terminals as **one MCP server**, on its own loopback listener. You write no server, pick no port and handle no credentials. The host owns the transport, a per-terminal credential, the project binding and revocation; the plugin supplies the data and the code behind its tools.

A plugin's server can carry two kinds of tool:

- **The database tools.** Declaring any [database](./contribution-points.md#databases--shipped) gets the server the host's own read-only `database_schema` and `database_query`, with no `mcp:expose` and no code from you.
- **Your own tools**, declared as a `contributes.agentMcp` endpoint and registered from `activate()` with [`host.mcp.registerTools`](./host-api.md#mcpregistertools). This is where writes with rules go: a split that must balance, an id that must be minted, a remote API behind the data.

For a data plugin that makes three routes, and a good plugin offers all three:

| Route | For | Reaches |
| --- | --- | --- |
| The database tools | Reads: schema, lookups, totals, "what did I spend on groceries" | Agents Daintree launched, with the plugin's access at **Read only** or **Read and write** |
| Your own tools | Writes that have rules, and reads that need your code | Agents Daintree launched, with access at **Read and write** |
| Files or `sqlite3` under the plugin's `AGENTS.md` | The fallback every agent has, for data in the project | Every agent, including one launched outside Daintree or by a CLI Daintree can't wire. A `local` database has no path in the project, so it has no fallback: only the tools reach it |

Build the tools first and the fallback second: an agent with the tools reads through a bounded query and writes through your validation, and the contract in `AGENTS.md` tells every other agent how to do the same by hand. `plugins/sample-project/acme.ledger` is all three in one zero-build plugin.

### One server per plugin

The server is named `daintree-<name>`, from the short name the plugin declares as [`mcpName`](./manifest.md#mcpname) in its manifest (`"ledger"` → `daintree-ledger`). A plugin that declares none is named after the last segment of its manifest id. The name is the same in every project, so a permission allowlist written against `mcp__daintree-ledger__database_query` keeps working in the next project and the next clone — unless a collision (below) gives the plugin a suffix there.

The database tools and your own tools are listed together on that one server, so an agent sees them as one plugin's tools. A plugin with a database and no `agentMcp` endpoint gets a server with just the database tools; a plugin with an endpoint and no database gets just its own. `database_schema` and `database_query` are reserved: a roster that registers either name is rejected.

Names only collide in two ways: an installed plugin and a project copy of the same plugin in one launch, or two plugins that chose the same short name. The installed copy, or the plugin whose manifest id sorts first, keeps the plain name, and the other gets a short hash suffix (`daintree-ledger-3f9a2c1e`). The suffix is stable — it comes from the plugin's identity, not from the project or the order plugins loaded in — and it is the only place a hash appears. Choose a short name specific enough not to collide: `ledger` in a household-finance plugin is fine; `data` is not. The whole key is kept within 25 characters, because Claude names a tool `mcp__<server>__<tool>` under a 64-character limit, so the short name has 16 characters to work with.

### Manifest

```json
{
  "name": "acme.ledger",
  "mcpName": "ledger",
  "capabilities": ["mcp:expose", "fs:project-write"],
  "contributes": {
    "databases": [
      { "id": "ledger", "description": "Household transactions, amounts in integer cents." }
    ],
    "agentMcp": [
      {
        "id": "data",
        "name": "Household ledger",
        "description": "Read and append transactions in this project's ledger database.",
        "mode": "tools"
      }
    ]
  }
}
```

The `mcp:expose` capability is required for `agentMcp` — the manifest is rejected without it (`mcp_expose_capability_required`) — and not for the database tools. One endpoint per plugin; its `id` is what `registerTools` binds a roster to, not the server's name. Field reference and limits are in [Contribution points → Agent MCP endpoints](./contribution-points.md#agent-mcp-endpoints--shipped).

### Registering tools

Bind the roster from `activate()` with [`host.mcp.registerTools`](./host-api.md#mcpregistertools):

```ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  await host.mcp.registerTools("data", {
    list_transactions: {
      description: "A page of this project's ledger transactions, newest first.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        additionalProperties: false,
      },
      async execute(args, caller, signal) {
        // `args` already matches inputSchema; `limit` is optional, so default it.
        const limit = typeof args.limit === "number" ? args.limit : 50;
        // `caller.projectId` is the project the calling terminal belongs to.
        return { transactions: await readTransactions(caller.projectId, limit, signal) };
      },
    },
  });
}
```

`plugins/sample-project/acme.ledger` is a working project plugin built on this surface: a roster over a database declared in `contributes.databases` and opened with [`host.db`](./host-api.md#db--host-managed-sqlite), with an `AGENTS.md` data contract and a tool for the one write rule the schema cannot hold. It is a data plugin with no view: besides this endpoint it contributes only the database, with the `fs:project-write` capability a project database needs. Copy its roster, argument checks and storage. Its one server, `daintree-ledger`, carries the host's `database_schema` and `database_query` beside its own tools, so an agent reads the ledger with SQL and writes it through the tools that keep the rules: at **Read only** access it gets the reads, and at **Read and write** the writes as well.

What the host does with the roster:

- **Lazy activation still applies to your tools.** An agent's first `tools/list` or `tools/call` activates the plugin if it has not run yet, and waits briefly for the roster to register. The database tools are host code: listing or calling them never starts your plugin.
- **Your roster is advertised verbatim.** `tools/list` returns the database tools, if any, and exactly the tools you registered — name, description, `inputSchema`, optional `outputSchema`, and the `annotations` you declared — and nothing else: no resources, no prompts, no server instructions. Registering again replaces the roster and sends `notifications/tools/list_changed`.
- **Tools may carry caution hints, never a safety claim.** Set `annotations: { destructiveHint, idempotentHint, openWorldHint }` to state the MCP defaults explicitly (destructive, not idempotent, open-world) for clients that do not assume them; an omitted hint means the default. `destructiveHint` and `openWorldHint` accept only `true`, `idempotentHint` either value, and a plugin cannot declare `readOnlyHint` at all. A roster that says its tool is read-only, non-destructive or closed-world is rejected, because clients such as Codex ask less for tools described that way — see [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).
- **Arguments are checked against `inputSchema`.** Each schema is compiled when the roster registers, and a call that does not match it is answered with a tool error naming the failure before your code runs. Arguments that match reach `execute` exactly as the agent sent them — nothing coerced, defaulted or stripped. Checks a schema cannot express, such as path containment or resource ownership, are still yours.
- **Results are serialized JSON.** Whatever `execute` returns is `JSON.stringify`-ed (`undefined` becomes `null`) and sent as the tool's text content. With an `outputSchema` the result must also be a JSON object matching it, which is sent as `structuredContent`. A thrown error becomes a tool error carrying its message.
- **Calls are cancellable.** The `signal` aborts on the 60-second timeout, when the agent cancels, when the session closes or the credential is revoked, and when the roster changes under a running call. Pass it on to anything long-running.

### Access: off, read only, read and write

Each plugin has one agent access setting, in **Project settings → Plugins → Agent tools**:

| Setting               | The agent gets                        |
| --------------------- | ------------------------------------- |
| **Off** (the default) | No server                             |
| **Read only**         | The database tools                    |
| **Read and write**    | The database tools and your own tools |

Read only is about which tools are offered, not a sandbox: it filters no rows, and an agent that can run `sqlite3` can still open a project database's file. Read and write never makes the database tools writable either; writes happen only through your tools, where your rules apply. A plugin with no database has nothing to offer at Read only, so its choice is Off or Read and write; one with a database and no `agentMcp` endpoint has nothing more at Read and write, so its choice is Off or Read only. For an installed plugin, whose databases are shared by every project, see [Installed plugins and shared data](#installed-plugins-and-shared-data) before relying on the database tools.

The setting belongs to the plugin _instance_: an installed plugin and a project copy of the same manifest id are two settings. For a project plugin, the user's answer beats the repository's [default](#project-defaults-daintreemcpjson), and with neither the plugin is off. An **installed** plugin can also be set once for every project — the right default for data that belongs to the user rather than a project, such as a personal CRM or a notes index — and a project's own setting still overrides that. A repository can never turn an installed plugin on. See [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).

Lowering the setting revokes every live credential it no longer allows in that project, and running agents lose those tools on their next request. Unloading the plugin — disable, uninstall, project close, trust revoke, or a reload that changes what it declares for agents — does the same for its whole server. Raising it reaches only agents launched afterwards; see [Reaching an agent](#reaching-an-agent).

### Reaching an agent

Declaring a database or an endpoint exposes nothing. A plugin's server reaches an agent only when all of these hold:

1. **The plugin has access in the project** — **Read only** for the database tools, or **Read and write** for your own tools as well — from the user's setting, an installed plugin's every-project setting, or the repository's default. See [Access](#access-off-read-only-read-and-write).
2. **Daintree's MCP server is enabled** (Settings → MCP server), because the plugin's server is served on that listener. The project's Daintree MCP tier does not matter: plugin servers are handed over even when it is off.
3. **The plugin is loaded** — enabled, not blocklisted, and for a project plugin, loaded for this project.
4. **The agent was launched after access was given, by a CLI Daintree can wire.** Each launch in the project is handed one server per plugin with access, through the mechanism its registry entry declares in `capabilities.launchMcp` (`shared/config/launchMcp.ts`). Every mechanism is one the CLI itself merges over the user's own servers, and none writes into the user's agent config or the repository: a file, when one is needed, is written `0600` under `userData` and deleted when the terminal exits, and a bearer travels in that file or the terminal's environment, never on the command line.

| Agent | How the servers are handed over |
| --- | --- |
| Claude Code | `--mcp-config <file>` |
| Codex | `-c mcp_servers.<key>.url=…` and `bearer_token_env_var`, the bearer in the environment |
| Gemini CLI | a settings file named by `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, its lowest-precedence layer; an admin's own system-defaults file is carried into it |
| opencode | `OPENCODE_CONFIG_CONTENT`, merged over every config file; an inherited value is carried into it |
| GitHub Copilot CLI | `--additional-mcp-config @<file>` |
| Amp | `--mcp-config <file>` |
| Qwen Code | `--mcp-config <file>` |
| Mistral Vibe | `VIBE_MCP_SERVERS`, each bearer read from its own environment variable |

Cursor, Grok, Kimi Code, Antigravity, Crush, Kiro and Goose have no launch-time mechanism that adds to the user's servers without replacing them, so they are not handed plugin servers; nor are the in-app Daintree Assistant and help sessions. Gemini CLI starts no MCP server at all in a folder the user has not trusted.

**An agent's servers are fixed when it launches.** None of these CLIs reads a new MCP server after it has started, and Claude Code's `/mcp` only reconnects servers the session already has. Giving a plugin access, or a plugin loading for the first time, reaches agents launched afterwards: relaunch the agent — not Daintree — to pick it up. Plugin code is different: edits to a project plugin hot-reload with no Daintree restart, and running agents keep its tools across the reload as long as it leaves what the plugin declares for agents — its capabilities, scopes, `agentMcp` endpoint, databases and `mcpName` — unchanged; they see the re-registered roster through `notifications/tools/list_changed`. A reload that changes any of those, and any other unload, revokes what running agents were given, and they have to be relaunched.

### Project defaults: `.daintree/mcp.json`

A project that ships its own plugins can give them access for everyone who opens it, so an agent launched in a fresh clone already has the project app's tools:

```json
{ "plugins": { "acme.ledger": "read-write", "acme.crm": "read-only" } }
```

Keys are manifest ids; the value is `"off"`, `"read-only"` or `"read-write"`. [`examples/ledger-project/.daintree/mcp.json`](./examples/ledger-project/.daintree/mcp.json) is a copy to start from, for a project that commits `acme.ledger` to its own `.daintree/plugins/`. The list form from before access levels, which named endpoint ids (`["@databases", "data"]`, `"*"` or `true`), is still read; write new files in the form above.

A default only reaches a **project plugin of the same project**, which loads only once the user trusts the project's plugins — trust that already lets its code run. An installed plugin is never given access by a repository, because that would let any clone read the user's own plugin data through their agents. The file is re-read at every agent launch; a malformed entry is skipped, and a symlinked file or `.daintree/` directory is ignored. **Agent tools** in Project settings shows which plugins have access by the project's default, and a choice there is recorded as the user's answer, which the file no longer overrides.

### Installed plugins and shared data

An installed plugin can only declare `"local"` databases, and a local database is one file per plugin in the user's plugin data directory, shared by every project. The database tools don't know your data model, so they cannot filter it by project: giving an installed plugin **Read only** or **Read and write** access in one project lets agents there read, through `database_query`, what your plugin stored for every other project, and making that the every-project default lets every project's agents read it. The **Agent tools** setting says so beside the choice.

Only your own tools can keep projects apart. If your installed plugin keeps per-project data — a time tracker, a CRM keyed by project — give agents your own read and write tools and scope every query by `caller.projectId`, which is the project the calling terminal belongs to, and don't count on the database tools as part of that plugin's agent access: any read through them reaches every project's rows. If the data belongs to the user rather than a project, a personal CRM or a notes index, there is nothing to keep apart, and the every-project setting above saves the user giving the plugin access in each project. A project plugin's databases belong to that project alone, `"local"` ones included, and its tools are bound to the project that loaded it.

### Several data plugins side by side

Each plugin is its own server with its own setting. With three data plugins in a project:

| Plugin | Setting | The agent sees |
| --- | --- | --- |
| `acme.ledger` | Read and write | `daintree-ledger`: `database_schema`, `database_query`, and the ledger's own tools |
| `acme.crm` | Read only | `daintree-crm`: `database_schema`, `database_query` |
| `acme.notes` | Off | Nothing |

Every server with a database has its own `database_query`; the server name says which plugin's data it reads, and its `databaseId` argument picks one of that plugin's databases. A query never reaches across servers, so an agent answering "which CRM contacts owe me money?" queries each plugin and joins the results itself. Say so in each plugin's `AGENTS.md` if a question needs both.

### Tools don't show up in `/mcp`

Claude Code's `/mcp` lists the servers a session has; other CLIs have their own list (`codex mcp list`, Gemini CLI's `/mcp`, …). When a plugin's server is missing, check in this order:

1. **Access is off.** Project settings → Plugins → Agent tools, for the right copy of the plugin — an installed plugin and a project copy are set separately. A project's own setting beats both the repository default and an installed plugin's every-project setting.
2. **Daintree's MCP server is off.** Settings → MCP server. Every plugin server is served on its listener.
3. **The plugin isn't loaded.** The plugin manager shows it disabled, blocklisted, **Staged**, **Unreadable**, or for a project plugin, not yet trusted for this project.
4. **The agent started before access was given, before a reload that changed the plugin's agent surface, or outside Daintree.** Only a launch from a Daintree terminal, after the plugin was given access, is handed its server, and a reload that changes what the plugin declares for agents revokes what running agents were given. Relaunch the agent; `/mcp` reconnecting is not enough, and a CLI started in your own terminal never gets Daintree's servers.
5. **The CLI has no launch mechanism.** Only the agents in the [table above](#reaching-an-agent) are handed plugin servers. The others work through the fallback in `AGENTS.md`.
6. **You're looking for the wrong name.** The server is `daintree-<mcpName>`, or `daintree-` and the last segment of the manifest id, with a hash suffix only on a collision. Two copies of one plugin in a launch show up as two servers.

When the server is there but tools are missing: at **Read only** your own tools are left off by design; a roster that breaks a limit (a bad schema, a name over 32 characters, a reserved name, an annotation that claims safety) is rejected whole — `registerTools` throws at your call site, and if that escapes `activate()` the plugin manager's detail pane shows the failed activation; and a plugin with no database has no database tools. `database_query` reporting a database missing means your code has not created it yet — the tools read what exists and never create a file.

Because only CLIs with a launch-time mechanism are handed servers, and only once a plugin has access, the tools are an addition to a project app's data path, never the whole of it. Every agent can read and write files and run `sqlite3`, so for data stored in the project the data itself, the contract in the plugin's `AGENTS.md` and a report script are what every agent reaches; the tools give the agents that have them a safer, validated way to do the same. See [Patterns → Write the data contract down](./patterns.md#write-the-data-contract-down).

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
| Let agents read your plugin's SQLite data | Declare it in `contributes.databases` — the plugin's server gets `database_schema` and `database_query` with no code |
| Let agents write data that has rules | Agent MCP endpoint tools that enforce them, beside the database tools |
| Give Daintree and its in-app Assistant a tool backed by an existing stdio MCP server | MCP server (`mcpServers`) |
| Teach the agent a methodology or rubric | Skill |
| Let terminal agents reach an external API (Linear, Jira, Sentry) | Agent MCP endpoint, calling the API from your plugin's `main` |
| Provide a checklist or step-by-step | Skill |
| Share knowledge that travels cleanly across projects | Skill |
| Ship a tool with a project, committed to its repository | Agent MCP endpoint — the only one of the three a `scope: "project"` plugin may declare |
| Hand one record — a card, a message — to an agent for the user to instruct | `host.sendToAgent` or a drag, not MCP — see [Patterns → Hand work to an agent](./patterns.md#hand-work-to-an-agent) |

Plugins often combine them — for example, a Linear plugin might serve terminal agents its issue tools through an agent MCP endpoint and ship a skill that teaches the agent the team's preferred ticket planning format.

## What Daintree does not do

- Does not provide a "PreToolUse/PostToolUse hook" contribution point, and no contribution intercepts an agent's tool calls: an agent MCP endpoint serves your own tools and never sees the agent's calls to anything else. This is deliberate — it keeps the extension model uniform and reuses the MCP ecosystem.
- Does not proxy a plugin's own MCP server to terminal agents. An `agentMcp` endpoint's tools are registered in-process through the host API; there is no mode that forwards an agent to a server the plugin runs.
- Does not expose a subagent spawning API. Daintree creates parallel agents natively. Plugins that want to coordinate multiple agents use MCP and skills to direct Daintree's orchestration, not a dedicated subagent contribution.
- Does not allow a plugin to replace the agent entirely. Agent providers are configured at the Daintree level (OpenAI-compatible base URLs), not through plugins.
