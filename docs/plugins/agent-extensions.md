# Agent Extensions

Daintree is an orchestration layer for AI coding agents. Plugins touch MCP in two directions, and the two are easy to confuse:

| Contribution | Who is the MCP client | Who calls the tools | Reaches agents in Daintree's terminals |
| --- | --- | --- | --- |
| `mcpServers` | **Daintree.** It spawns your stdio server and talks to it. | Only a caller of the renderer's `window.electron.pluginMcp` IPC surface (`listTools`, `getFullSchema`, `callTool`), and nothing in Daintree calls those today; the plugin manager lists servers, restarts them and shows their stderr | **No.** These tools never appear in the `tools/list` a terminal agent sees. |
| `agentMcp` (and `databases`) | **The agent.** Daintree hosts one MCP server per plugin on its own loopback listener and serves the tools you register, beside the host's database tools when the plugin declares a database. | Agents running in Daintree's terminals, in projects where the plugin has agent access: **Read only** for the database reads, **Read and write** for declared writes and your tools as well | **Yes** — Claude Code, Codex, Gemini CLI, opencode, Copilot CLI, Amp, Qwen Code and Mistral Vibe launches. See [Reaching an agent](#reaching-an-agent). |

If you want an agent in a Daintree terminal to call your tools, you want `agentMcp`; if you only want it to read your plugin's SQLite data, declaring the database is enough. An `mcpServers` contribution cannot do either on its own, however it is configured. To reuse an existing stdio server's tools for agents, keep it in `mcpServers` and name the tools agents get in an `agentMcp` endpoint's `source` — see [Serving a contributed server's tools](#serving-a-contributed-servers-tools). `daintree-plugin validate` and `doctor` warn about any server no endpoint bridges.

Skills are a third route: the plugin ships markdown skill files that Daintree serves through `skills.search` / `skills.load` tools — on the plugin's own agent MCP server, beside its tools, and on Daintree's own MCP server. Skills are pure declarative knowledge — prompt snippets, workflow instructions, rubrics — injected into the agent's context on demand. See [Who reaches skills](#who-reaches-skills).

None of the three changes which agent CLI runs. A separate contribution point, `contributes.agents` (requires the `agent:register` capability), goes the other direction: it teaches Daintree about a launchable agent CLI it doesn't ship in-tree, so the CLI appears as a named, selectable agent rather than a generic shell. See [Contribution points → Agents](./contribution-points.md#agents--shipped-minimal-tier) for that manifest shape.

## MCP servers

Daintree supervises any MCP server a plugin ships. It spawns the process lazily, manages lifecycle, acts as the server's MCP client, and cleans up on Daintree exit. The server's tools are reachable only through the renderer's `window.electron.pluginMcp` IPC surface (`listTools`, `getFullSchema`, `callTool`), and nothing in Daintree — the in-app Daintree Assistant included — calls those three today: the plugin manager lists servers, restarts them and shows their stderr. They are not bridged into terminal agents or into Daintree's own MCP server; for agents, see [Agent MCP endpoints](#agent-mcp-endpoints).

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

The server runs in the plugin directory with a minimal environment: the allowlist every process the host spawns for a plugin is built from (`PATH`, `HOME`, locale, temp and the Windows essentials), proxy and CA settings, then your `env` entries (`minimalWorkerEnv` in `electron/utils/minimalSpawnEnv.ts`). Nothing else from Daintree's environment reaches it, so pass anything more the server needs, such as an API key, through `env`.

**Intentionally excluded:** remote transports (no `url` field), explicit transport declarations (stdio is inferred from `command`'s presence), per-server working directories, restart policies. Shape deliberately matches the Claude Desktop / Cursor MCP config format — authors shipping the same server as a standalone Claude Desktop extension can copy their config verbatim.

### Lifecycle

Daintree spawns MCP servers **on first tool enumeration**, not at plugin activation. This avoids the well-documented issue where IDEs with many installed MCP servers accumulate subprocesses and leak memory over time.

1. A plugin's MCP servers are registered at plugin load but not spawned.
2. The first `pluginMcp.listTools` (or `pluginMcp.getFullSchema`) call for a server goes through `ensureServerStarted()` (`electron/ipc/handlers/pluginMcp.ts`), which spawns the subprocess, waits for the `initialize` handshake, then returns the tool list / schema.
3. The server stays running. Teardown is keyed by **plugin**, not by any agent session: `PluginMcpSupervisor.shutdown({ pluginId })` runs on plugin unload, and `shutdownAll()` runs on app shutdown.
4. Teardown reaches the whole process tree, because the direct child is often a wrapper (`npx`, `uvx`, a `.bat`) whose real server is a grandchild. On POSIX each server is spawned as its own process group: the supervisor SIGTERMs the group, calls `subprocess.kill()` with no arguments so execa's `forceKillAfterDelay` escalation stays active (passing an explicit signal would disable it), and SIGKILLs whatever of the group outlives `SHUTDOWN_GRACE_MS` (3 seconds). On Windows a tree kill (`electron/utils/windowsTreeKill.ts`) runs first, while the root it walks from is still alive, and the direct kill after it. A server that exits on its own has whatever it left running in its group reaped the same way.

**Tool discovery:** Daintree queries each server's tool list lazily as well. The list is fetched on first spawn and cached (invalidated on crash or restart). Discovery is capped and two-tier, so a server that ships with 40 tools does not hand its IPC caller 40 full schemas at once: tier-1 (`pluginMcp.listTools`) returns terse tool summaries, bounded by the `maxToolsPerSession` cap (`clampMaxTools`), and the full JSON schema for a tool is fetched via tier-2 (`pluginMcp.getFullSchema`) only when the caller asks for that tool.

**Crash handling:** if a server process dies unexpectedly, the supervisor transitions it to status `crashed`, records `lastError`, invalidates its tool cache, and rejects any pending tool calls (`handleSubprocessExit`, `electron/services/PluginMcpSupervisor.ts`). There is **no** automatic retry or backoff, and no "degraded" state — the status enum is `spawning | ready | crashed | stopped`. The supervisor never respawns a crashed server on its own: the next tool listing, schema fetch or call spawns it again (`ensureServerStarted` in `electron/ipc/handlers/pluginMcp.ts`), as a manual restart through the `pluginMcp.restart` IPC does.

**Tool call gating:** every `pluginMcp.callTool` passes two checks before it reaches the server (`electron/ipc/handlers/pluginMcp.ts`):

1. **A rate limit**, checked first so a throttled call never spends a prompt: each server allows a burst of 20 calls, then refills at one call per second (`PluginMcpRateLimiter`). A call over the limit is denied with a retry delay.
2. **Per-tool consent.** The host derives a danger tier from the tool's annotations — `readOnlyHint: true` is D0, the default is D1, `destructiveHint: true` is D2, and `openWorldHint: true` raises any of those one tier — and caps it by the plugin's declared capabilities: D2 for a plugin that declares a capability that elevates its actions to confirm (`shell:exec`, `git:write`, `fs:project-write` and the rest of `CONFIRM_TRIGGERING_CAPABILITIES`), D1 otherwise (`PluginMcpTierAuth`). A tool whose tier is above the cap is refused outright, never downgraded, so a D3 tool never runs. Any other tool asks the user before its first call, at every tier; the user can approve once or remember the approval, which is pinned to a fingerprint of the tool's description, input schema and hints, so a server that changes any of them asks again.

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

- **The database tools.** Declaring any [database](./contribution-points.md#databases--shipped) gets the server the host's own read-only `database_schema` and `database_query`, plus one tool per [query declared](./contribution-points.md#declared-queries) on it, a read or a write, with no `mcp:expose` and no code from you.
- **Your own tools**, declared as a `contributes.agentMcp` endpoint and registered from `activate()` with [`host.mcp.registerTools`](./host-api.md#mcpregistertools). This is where writes go that one statement cannot express: a split that must balance, an id that must be minted, a remote API behind the data.

For a data plugin that makes three routes, and a good plugin offers all three:

| Route | For | Reaches |
| --- | --- | --- |
| The database tools | Reads: schema, lookups, totals, "what did I spend on groceries" | Agents Daintree launched, with the plugin's access at **Read only** or **Read and write** |
| Declared write queries | Writes one statement can express, under your schema's rules | Agents Daintree launched, with access at **Read and write** |
| Your own tools | Writes that need your code, and reads that do | Agents Daintree launched, with access at **Read and write** |
| Files or `sqlite3` under the plugin's `AGENTS.md` | The fallback every agent has, for data in the project | Every agent, including one launched outside Daintree or by a CLI Daintree can't wire. A `local` database has no path in the project, so it has no fallback: only the tools reach it |

Build the tools first and the fallback second: an agent with the tools reads through a bounded query and writes through your validation, and the contract in `AGENTS.md` tells every other agent how to do the same by hand. `plugins/sample-project/acme.ledger` is all of them in one zero-build plugin.

### One server per plugin

The server is named `daintree-<name>`, from the short name the plugin declares as [`mcpName`](./manifest.md#mcpname) in its manifest (`"ledger"` → `daintree-ledger`). A plugin that declares none is named after the last segment of its manifest id. The name is the same in every project, so a permission allowlist written against `mcp__daintree-ledger__database_query` keeps working in the next project and the next clone — unless a collision (below) gives the plugin a suffix there.

The database tools and your own tools are listed together on that one server, so an agent sees them as one plugin's tools. A plugin with a database and no `agentMcp` endpoint gets a server with just the database tools; a plugin with an endpoint and no database gets just its own. A plugin that contributes [skills](#skills) also gets `skills.search` and `skills.load` there, on any access level that serves the plugin at all. `database_schema` and `database_query` are reserved, and so is the name of every query the manifest declares: a roster that registers one is rejected.

Names only collide in three ways: an installed plugin and a project copy of the same plugin in one launch, two plugins that chose the same short name, or a name taken from the manifest id (`acme.docs`) that lands on `daintree-docs` or `daintree-runbooks`, which belong to the [Daintree Assistant](#the-daintree-assistant). The installed copy, or the plugin whose manifest id sorts first, keeps the plain name, and the other gets a short hash suffix (`daintree-ledger-3f9a2c1e`); a name that lands on one of the Assistant's always gets the suffix. The suffix is stable — it comes from the plugin's identity, not from the project or the order plugins loaded in — and it is the only place a hash appears. Choose a short name specific enough not to collide: `ledger` in a household-finance plugin is fine; `data` is not. The whole key is kept within 25 characters, because Claude names a tool `mcp__<server>__<tool>` under a 64-character limit, so the short name has 16 characters to work with.

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

`plugins/sample-project/acme.ledger` is a working project plugin built on this surface: a roster over a database declared in `contributes.databases` and opened with [`host.db`](./host-api.md#db--host-managed-sqlite), with an `AGENTS.md` data contract and a tool for the one write rule the schema cannot hold. It is a data plugin with no view: besides this endpoint it contributes only the database, with the `fs:project-write` capability a project database needs. Copy its roster, argument checks and storage. Its one server, `daintree-ledger`, carries the host's `database_schema` and `database_query` and its declared `add_transaction` write beside its own tools, so an agent reads the ledger with SQL and writes it through the tools that keep the rules: at **Read only** access it gets the reads, and at **Read and write** the writes as well.

What the host does with the roster:

- **Bind the roster during `activate()`.** `registerTools` is revoke-guarded like the other registration methods: called after `activate()` resolves or times out, it throws. Your `execute` functions keep running for the plugin's whole lifetime; only binding the roster is limited to activation. To change the roster, change the code and reload the plugin.
- **Lazy activation still applies to your tools.** An agent's first `tools/list` or `tools/call` activates the plugin if it has not run yet, and waits up to 5 seconds for the roster to register; one that has not registered by then is listed as no tools. The database tools are host code: listing or calling them never starts your plugin, so a server with only the database tools — a plugin with no endpoint, or one at **Read only** — never activates it.
- **Your roster is advertised verbatim.** `tools/list` returns the database tools, if any, and exactly the tools you registered — name, description, `inputSchema`, optional `outputSchema`, and the `annotations` you declared — and nothing else: no resources, no prompts, no server instructions. Registering again within the same activation replaces the roster and sends `notifications/tools/list_changed`, as does a reload that re-registers it.
- **Tools may carry caution hints, never a safety claim.** Set `annotations: { destructiveHint, idempotentHint, openWorldHint }` to state the MCP defaults explicitly (destructive, not idempotent, open-world) for clients that do not assume them; an omitted hint means the default. `destructiveHint` and `openWorldHint` accept only `true`, `idempotentHint` either value, and a plugin cannot declare `readOnlyHint` at all. A roster that says its tool is read-only, non-destructive or closed-world is rejected, because clients such as Codex ask less for tools described that way — see [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).
- **Arguments are checked against `inputSchema`.** Each schema is compiled when the roster registers, and a call that does not match it is answered with a tool error naming the failure before your code runs. Arguments that match reach `execute` exactly as the agent sent them — nothing coerced, defaulted or stripped. Checks a schema cannot express, such as path containment or resource ownership, are still yours.
- **Results are serialized JSON.** Whatever `execute` returns is `JSON.stringify`-ed (`undefined` becomes `null`) and sent as the tool's text content. With an `outputSchema` the result must also be a JSON object matching it, which is sent as `structuredContent`. A thrown error becomes a tool error carrying its message.
- **Calls are cancellable.** The `signal` aborts on the 60-second timeout, when the agent cancels, when the session closes or the credential is revoked, and when the roster changes under a running call. Pass it on to anything long-running.

### Serving a contributed server's tools

An endpoint can take its tools from one of the plugin's own `mcpServers` instead of `registerTools`. This is the explicit adapter between the two directions: the server stays a host-client server that Daintree supervises, and the endpoint names, one by one, which of its tools agents get and under what name.

```json
{
  "capabilities": ["mcp:expose"],
  "contributes": {
    "mcpServers": [
      { "id": "catalog", "name": "Catalog", "command": "node", "args": ["dist/server.js"] }
    ],
    "agentMcp": [
      {
        "id": "catalog-tools",
        "name": "Catalog",
        "mode": "tools",
        "groups": [{ "id": "search", "name": "Search the catalog", "access": "read" }],
        "source": {
          "mcpServer": "catalog",
          "tools": [{ "name": "search_catalog", "serverTool": "catalog.search", "group": "search" }]
        }
      }
    ]
  }
}
```

- **Explicit allowlist.** `source.tools` lists every tool served; `name` is the agent-facing name in the same grammar as a registered tool, `serverTool` the exact name on the server, and `description` optionally replaces the server's own (otherwise cut to 400 bytes). A tool the server lists but the manifest doesn't name never reaches an agent, including one the server adds later. The allowlist counts toward the 16-tool budget with declared queries, and `group` follows the same rules as a registered tool's.
- **Same access model.** The endpoint is an ordinary `agentMcp` endpoint: per-project access, groups, Assistant opt-in, launch injection, revocation and the grant fingerprint all apply unchanged. The fingerprint also covers the bridged server's `command`, `args` and `env`, so changing them invalidates held credentials.
- **Lazy, on the owning backend.** Nothing starts when the plugin loads or an agent launches. The first `tools/list` or `tools/call` from an agent with access starts the server through the supervisor, with `${settings:*}` resolved on the backend that holds the plugin; its schemas are then read and checked like a registered roster, and a missing tool or a schema the host cannot enforce leaves the endpoint with no tools. `host.mcp.registerTools` is refused for a bridged endpoint.
- **Restarts and failures.** When the server exits, crashes, is restarted (for example after a secret rotates) or sends `notifications/tools/list_changed`, the roster is dropped and sessions get `tools/list_changed`; the next request starts the server again and reads its tools afresh. A call in flight when the server goes fails as a tool error.
- **Calls and results.** Arguments are checked against the server's `inputSchema` before it is called. Calls keep the 60-second budget and are cancelled on the wire with `notifications/cancelled`; a late answer is dropped, and a cancelled call may already have taken effect. The server's text content and its `isError` are forwarded as they are, within the 256 KiB result limit.
- **Unsupported.** Only stdio tools are bridged. Not forwarded: non-text content (images, audio, resource links, embedded resources — the call fails as a tool error), `structuredContent` and `outputSchema`, the server's tool annotations and `_meta`, its `instructions`, resources, prompts, completions, logging, progress notifications and tasks. Daintree declares no client capabilities, so a server's `sampling/createMessage`, `roots/list` and `elicitation/create` requests are refused; `ping` is answered.
- **Project plugins.** A `scope: "project"` plugin may declare `mcpServers` only when every one of them is bridged this way, and Daintree's own host-client surface (`window.electron.pluginMcp`) neither lists nor calls a project plugin's servers. Each project's copy runs its own server.
- **Installed plugins.** An installed plugin's server is one process shared by every project it has access in. Project grants decide which agents may call it; they do not partition what the server itself stores or reaches.

### Database tools

The host serves two tools on a plugin's server when the plugin declares any database, both annotated `readOnlyHint: true` (`electron/services/pluginAgentMcp/databaseTools.ts`):

| Tool | Arguments | Returns |
| --- | --- | --- |
| `database_schema` | `databaseId?` — omit it to list every declared database | `{ databases, truncated }`: per database its `id`, `location`, `description`, `exists`, and up to 1,000 schema `objects` (`type`, `name`, `tableName`, and the `CREATE` statement as `sql`), with a per-database `truncated` and `error` |
| `database_query` | `databaseId`, `sql`, `params?`, `rowLimit?` | `{ databaseId, columns, rows, truncated }`, each row an array aligned with `columns` |

What the tools allow:

- **One statement that returns rows.** `sql` is a single `SELECT`, `WITH`, or a row-returning `PRAGMA` such as `table_info`, up to 65,536 characters, run on a read-only connection. A statement that returns no rows fails with `DB_NOT_A_QUERY`, and text after the first statement fails with `DB_MULTIPLE_STATEMENTS`. Attaching another file, loading an extension and the `temp_store_directory` / `data_store_directory` pragmas are refused.
- **Bound parameters.** `params` is an array for `?` placeholders or an object for `:name` placeholders (keyed `name` or `:name`), at most 128 entries, each a string, number or `null`.
- **Bounded results.** `rowLimit` defaults to 100 and cannot exceed 1,000. The whole result is kept just under the 256 KiB tool-result limit; rows past either bound are dropped and `truncated` is `true`, so page with `LIMIT`/`OFFSET` or a narrower `WHERE`.
- **JSON-safe values.** A blob comes back as `{ "blob": "<base64>" }`, and an integer outside JavaScript's safe range (beyond ±2^53) as a decimal string rather than a rounded number.
- **Nothing is created.** A database your code has not opened yet is reported by `database_schema` with `exists: false`, and `database_query` against it fails with `DB_NOT_FOUND`. The tools never create a file.

Each call runs in a short-lived process separate from Daintree's main process and from your plugin, under the same 60-second call timeout as your own tools.

### Declared queries

A [query declared on a database](./contribution-points.md#declared-queries) is a third database tool, specific where `database_query` is general: `month_total` instead of the SQL for a month's total. The host lists each one after `database_schema` and `database_query`, under the query's `name`, with its `description` and an input schema built from its `params` — every param required and held to the constraints it declares, nothing else accepted — and annotates it `readOnlyHint: true` itself. The agent passes the values; the SQL and the database come from the manifest and are never arguments. A call runs exactly like a `database_query` call on the declaring database (same read-only connection, refusals, timeout and result shape) with up to 1,000 rows, so no code of yours runs and **Read only** access is enough.

Use them for the reads an agent makes often or gets wrong: a total with a unit, a lookup by a key it would otherwise have to discover, a report that joins three tables. `database_query` stays on the server for everything else. Declared queries share the plugin's 16-tool budget with the tools you register, so a plugin with four declared queries can register twelve.

A `"write"` query is the same idea for a write: `add_transaction` as one `INSERT`, with the agent passing only the values. The host lists it only to an agent whose access is **Read and write**, annotated destructive and not idempotent rather than read-only, so a client asks before running it. It runs in its own transaction under the policy of a writable `host.db` open, never creates the database, and answers `{ databaseId, changes, lastInsertRowid }`, plus the rows of a `RETURNING` clause. Its params' constraints, which the host checks first, and your schema's constraints and triggers are its rules, since no code of yours runs. Declare a write when one statement and the schema say everything; register a tool when the write needs rules across rows, several statements, a value your code computes, or the caller. See [Declared queries](./contribution-points.md#declared-queries) for the full contract.

### Access: off, read only, read and write

Each plugin has one agent access setting, in **Project settings → Plugins → Agent tools**:

| Setting               | The agent gets                                         |
| --------------------- | ------------------------------------------------------ |
| **Off** (the default) | No server                                              |
| **Read only**         | The database tools, without declared writes            |
| **Read and write**    | The database tools, declared writes and your own tools |

Read only is about which tools are offered, not a sandbox: it filters no rows, and an agent that can run `sqlite3` can still open a project database's file. Read and write never makes `database_query` writable either; writes happen only through the writes you declare and your own tools, where your rules apply. A plugin with no database has nothing to offer at Read only, so its choice is **Off** or **On** — On is stored as read and write, and is what `.daintree/mcp.json` calls `"read-write"`; one with a database, no declared write and no `agentMcp` endpoint has nothing more at Read and write, so its choice is Off or Read only. Lowering a plugin from Read and write to Read only revokes the credentials that reached its declared writes, as it does those that reached its own tools. In `.daintree/mcp.json`, `"read-write"`, `"*"` and `true` include declared writes; an endpoint list from before access levels never does. For an installed plugin, whose databases are shared by every project, see [Installed plugins and shared data](#installed-plugins-and-shared-data) before relying on the database tools.

The setting belongs to the plugin _instance_: an installed plugin and a project copy of the same manifest id are two settings. For a project plugin, the user's answer beats the repository's [default](#project-defaults-daintreemcpjson), and with neither the plugin is off. An **installed** plugin can also be set once for every project — the right default for data that belongs to the user rather than a project, such as a personal CRM or a notes index — and a project's own setting still overrides that. A repository can never turn an installed plugin on. See [Trust model → Agent MCP endpoints](./trust-model.md#agent-mcp-endpoints-mcpexpose).

Lowering the setting revokes every live credential it no longer allows in that project, and running agents lose those tools on their next request. Unloading the plugin — disable, uninstall, project close, trust revoke, or a reload that changes what it declares for agents — does the same for its whole server. A reload here includes an upgrade and a `daintree-plugin dev` rebuild: one that keeps the agent declarations leaves running agents connected. Raising it reaches only agents launched afterwards; see [Reaching an agent](#reaching-an-agent).

### Tool groups

Read and write is one switch for all of a plugin's own tools, which is too coarse for a service plugin whose search tools a user would happily hand to every agent and whose commit tools they would not. Declare `groups` on the endpoint and the user allows each group on its own:

```json
"agentMcp": [
  {
    "id": "crm",
    "name": "Acme CRM",
    "mode": "tools",
    "groups": [
      { "id": "search", "name": "Search contacts", "access": "read" },
      { "id": "changes", "name": "Change contacts", "access": "write" }
    ]
  }
]
```

Every tool then names its group, and `registerTools` rejects the whole roster if one names none, names a group the manifest doesn't declare, or names one on an endpoint that declares no groups:

```ts
await host.mcp.registerTools("crm", {
  search_contacts: { group: "search", description: "…", inputSchema, execute: search },
  preview_contact_update: { group: "search", description: "…", inputSchema, execute: preview },
  commit_contact_update: { group: "changes", description: "…", inputSchema, execute: commit },
});
```

What changes for a grouped endpoint:

- **Groups are allowed by name, never by a level.** Project settings → **Agent tools** shows a switch per group under the plugin. The access level then covers only the plugin's databases, and a plugin without databases has no level at all. An answer recorded before the plugin declared groups — **Read and write** included — allows none of them, so a plugin that adopts groups starts with its own tools off until the user picks some.
- **`access` is your description, not a permission.** It is shown to the user as what the plugin says the group does. The host never turns it into a `readOnlyHint`, so a `read` group never changes whether an agent client asks before calling one of its tools — that stays the client's own setting — and no setting allows a group because it says `read`.
- **The roster is what the grant allows.** `tools/list` lists only the tools of the groups allowed when the agent launched, each with `_meta["dev.daintree/toolGroup"]` naming its group and class; a call to any other tool is answered as an unknown tool and never reaches your code. A cancelled or timed-out call to a `write` group's tool says the change may have been applied, as a declared write does.
- **Changes revoke.** Turning a group off revokes every credential that reached it. A user's choice records the group's class, so recasting a group from `read` to `write` (or back) turns it off until it is allowed again. A reload that changes the `groups` declaration revokes as any change to the agent declarations does, and registering a roster that changes which tools a group holds — adding, removing or moving one, in the same activation or after a reload — revokes every credential reaching the plugin's groups, because those were issued against the groups as they were.
- **The Assistant gets a group only by name too.** Under the Assistant switch each group has its own **Assistant can use …** switch, offered only for groups the project's agents have. Neither the Assistant's level nor a group's `read` class gives it one, and its [knowledge](#knowledge-for-the-assistant) is delivered only once it has every group.
- **Repository defaults name groups.** A project plugin's `.daintree/mcp.json` entry uses the object form, `{ "access": "read-only", "groups": ["search"] }`, where `access` is for its databases. A plain level, an endpoint list or `"*"` allows no group.
- **Shared data stays shared.** Allowing a group gives agents nothing of the plugin's databases: an installed plugin's [shared database warning](#installed-plugins-and-shared-data) is about the database level alone. Your tools still scope their own data by `caller.projectId`.

A recipe's `requiresAgentTools` is satisfied by a launch handed any of the plugin's tools, a single group included; it does not promise every group.

#### Preview and commit

A consequential operation — sending, deleting, charging, merging — is safest as two tools in two groups: one that works out exactly what would happen, and one that does it.

1. **`preview_*` in a `read` group** checks the request, resolves its targets and returns the exact change it would make, with a short-lived token bound to that change. It changes nothing.
2. **`commit_*` in a `write` group** takes the token, and refuses one that is unknown, expired, already used, issued for another `caller.projectId` or for a change the service has since moved past.

A user who allows only the read group gets agents that can investigate and propose; one who allows both still gets a change that matches a preview the agent saw. Who enforces what:

| Party | Enforces |
| --- | --- |
| **Daintree** | Which groups a credential reaches, per project and per launch; that a call names a listed tool and matches its `inputSchema`; revoking credentials when access, declarations or a tool's group change; binding `caller` to the launch's project and terminal. It cannot tell from a schema or a group's class what a tool really does. |
| **The agent client** | When to call a tool, and whether to ask the user first. Plugin tools never carry `readOnlyHint`, so clients apply their default caution to every one of them. |
| **The plugin** | That `preview` really changes nothing and `commit` does only what the token names; token expiry, single use and binding to `caller.projectId`; the service's own authorization and per-project data scoping; idempotency or a precondition check, so a retried commit doesn't apply twice. |

Allowing a write group is consent to the kind of change, not to any one of them.

### Reaching an agent

Declaring a database or an endpoint exposes nothing. A plugin's server reaches an agent only when all of these hold:

1. **The plugin has access in the project** — **Read only** for the database tools, or **Read and write** for declared writes and your own tools as well — from the user's setting, an installed plugin's every-project setting, or the repository's default. See [Access](#access-off-read-only-read-and-write).
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

These eight formats are the only ones, and the built-in entries above are the ones that declare them. Cursor, Grok, Kimi Code, Antigravity, Crush, Kiro, Goose, Aider and Open Interpreter have no launch-time mechanism that adds to the user's servers without replacing them, so they are not handed plugin servers; nor is an agent CLI a plugin contributes through `contributes.agents` unless it declares a `launchMcp` format (see [Agents](./contribution-points.md#agents--shipped-minimal-tier)). Gemini CLI starts no MCP server at all in a folder the user has not trusted.

### The Daintree Assistant

The in-app Daintree Assistant gets a plugin's server only when the user turns on **Daintree Assistant can use this plugin's tools** under that plugin in Project settings → **Agent tools**. It is off by default, set per plugin and per project, and only the user can set it: neither the repository's `.daintree/mcp.json` nor an installed plugin's every-project setting reaches it. It never goes past the plugin's access for the project's agents. The switch alone gives the Assistant the database tools that read; declared writes and the plugin's own tools need **Allow tools that change things** as well, which is offered only while the project's agents have **Read and write**. The Assistant can act across the whole project, so what a plugin's tools return reaches a powerful agent; read only is the default for that reason.

The Assistant's Claude Code, Codex and GitHub Copilot CLI sessions are handed the server beside their own servers at launch, by the same mechanism as the table above, under the plugin's usual key. No plugin is ever keyed `daintree-docs` or `daintree-runbooks`, the Assistant's own servers, or `daintree-decisions`, the server agents ask the person through: `docs`, `runbooks` and `decisions` are refused as an `mcpName`, and a name taken from the manifest id that would land on one gets a hash suffix like any other clash. A plugin whose key matches a server in the user's assistant folder is skipped, and that server stays as it is. Calls through the plugin's server show in the Assistant's activity and recent calls as `<key>.<tool>`, with the argument names but never their values. Switching it off, lowering the project's access below what the Assistant had, or the session ending revokes the Assistant's credential at once.

Even a CLI from the table is handed no plugin servers when:

- **The terminal is in a scratch workspace** rather than a project. Plugin access is set per project, so a scratch has none.
- **The launch inherits configuration Daintree must carry forward and cannot read.** An inherited `OPENCODE_CONFIG_CONTENT` or `VIBE_MCP_SERVERS` that does not parse, or a Gemini CLI system-defaults file that cannot be read or parsed, fails the preparation, and the agent launches without any of Daintree's servers rather than with the user's configuration hidden.
- **Plugins are still loading.** A launch waits up to 5 seconds for the plugin service to finish starting, and launches with no plugin servers if it has not; it then waits up to 5 seconds more for the project's own plugins, and launches with whichever have loaded. This mostly affects panes restored when Daintree starts.

**An agent's servers are fixed when it launches.** None of these CLIs reads a new MCP server after it has started, and Claude Code's `/mcp` only reconnects servers the session already has. Giving a plugin access, or a plugin loading for the first time, reaches agents launched afterwards: relaunch the agent — not Daintree — to pick it up. Plugin code is different: edits to a project plugin hot-reload with no Daintree restart, and running agents keep its tools across the reload as long as it leaves what the plugin declares for agents — its capabilities, scopes, `agentMcp` endpoint, databases (their declared queries included) and `mcpName` — unchanged; they see the re-registered roster through `notifications/tools/list_changed`. A reload that changes any of those, and any other unload, revokes what running agents were given, and they have to be relaunched.

### Knowledge for the Assistant

A plugin can also tell the Assistant how its tools should be used, so that knowledge arrives with the plugin instead of being copied into every repository's `.daintree/assistant/` folder. Declare it in `contributes.assistantKnowledge`, beside `agentMcp` or `databases`:

```json
{
  "contributes": {
    "assistantKnowledge": {
      "instructions": "./assistant/notes.md",
      "skills": [{ "id": "reconcile", "path": "./assistant/skills/reconcile" }],
      "references": [{ "id": "schema", "path": "./assistant/schema.md" }]
    }
  }
}
```

| Field | Notes |
| --- | --- |
| `instructions` | A `.md` file of short notes, added to the Assistant's prompt. |
| `skills` | Up to 16 skill directories in the Agent Skills layout, each with a `SKILL.md`. `id` is lowercase letters, digits and single hyphens, at most 32 characters. |
| `references` | Up to 32 `.md` files for the Assistant to read when a question needs them. `instructions` is reserved as an `id`. |

**When it is delivered.** Only to an Assistant that was given everything the plugin declares in the project: its databases, their declared writes and its own `agentMcp` endpoint. At read only that is a plugin whose only tools are its databases and that declares no writes; anything more needs **Allow tools that change things**. It is also left out while Daintree's MCP server is off, and when the plugin's server is skipped for a name clash with the user's assistant folder. It is read when an Assistant session starts, like the rest of the Assistant's folder: switching access off takes the plugin's tools away at once, and the knowledge leaves with the next new session.

**How the Assistant sees it.** The instructions go into the Assistant's prompt under their own heading, attributed to the plugin by name, id and version, inside a tag naming the plugin's MCP server. The Assistant is told they are the plugin author's notes on that plugin's tools: not the user speaking and not Daintree, unable to change its instructions, tools or permissions, and outranked by the user's own instructions. Nothing goes into the plugin's MCP server `instructions`, and nothing replaces Daintree's own prompt. Skills are mirrored as `<server key>-<id>` (`daintree-ledger-reconcile`) with `name` rewritten to match, and references to `reference/plugins/<server key>/<id>.md`. Every mirrored file opens with a line naming the plugin it came from.

**Markdown only, and bounded.** Every path is realpath-contained to the plugin directory. A skill is mirrored without its `scripts/` folder or any file that isn't `.md`, and a link inside it that leaves the plugin is skipped. Its `SKILL.md` keeps only frontmatter that describes it (`description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `license`, `compatibility` and `metadata`), so nothing can grant tools, add hooks or run it in another model, context or agent, and Claude Code's inline `` !`command` `` and fenced ` ```! ` forms are broken in every mirrored skill file so nothing in the text runs. Instructions over 4 KiB are never cut: they are handed over whole as `reference/plugins/<server key>/instructions.md`, and the prompt tells the Assistant to read that file before it uses the plugin's tools. A plugin's knowledge may total 512 KiB as handed over, attribution lines included. Past that, or when any part of it can't be read, resolves outside the plugin or would land on a file from the user's assistant folder, all of that plugin's knowledge is left out and the reason is logged.

Keep the instructions to what tool descriptions can't say. Codex's prompt file is held under 31 KiB in all, and when the user's instructions and every plugin's notes together would pass that, they move to one file the prompt points at.

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
5. **The CLI has no launch mechanism.** Only the agents in the [table above](#reaching-an-agent) are handed plugin servers; a plugin-contributed agent never is. The others work through the fallback in `AGENTS.md`.
6. **The launch could not be wired.** A terminal in a scratch workspace, a launch whose inherited `OPENCODE_CONFIG_CONTENT`, `VIBE_MCP_SERVERS` or Gemini CLI system-defaults file cannot be parsed, and a pane launched while plugins were still loading all start without plugin servers; see the list under [Reaching an agent](#reaching-an-agent). Relaunching once plugins have loaded fixes the last.
7. **You're looking for the wrong name.** The server is `daintree-<mcpName>`, or `daintree-` and the last segment of the manifest id, with a hash suffix only on a collision. Two copies of one plugin in a launch show up as two servers.

When the server is listed but its requests fail, a 401 for a recently revoked credential says why in its body (`relaunched`, `terminal-exited`, `plugin-unloaded`, `access-reduced`, `server-stopped`), and Daintree's log has a `main:PluginAgentMcp` line for every credential issued, held, kept and revoked, and for refused requests by category, rate-limited to one a minute per category and credential and keyed by credential id where the request carried a live or remembered one. A credential issued at launch and never revoked, yet refused, points at the request rather than the credential: the wrong route, the plugin not loaded, or access no longer covering its scope.

When the server is there but tools are missing: at **Read only** your own tools and declared writes are left off by design; a roster that breaks a limit (a bad schema, a name over 32 characters, a reserved name or a declared query's name, more tools than the 16 the declared queries leave room for, an annotation that claims safety) is rejected whole — `registerTools` throws at your call site, and if that escapes `activate()` the plugin manager's detail pane shows the failed activation; and a plugin with no database has no database tools. `database_query` reporting a database missing means your code has not created it yet — the tools read what exists and never create a file.

Because only CLIs with a launch-time mechanism are handed servers, and only once a plugin has access, the tools are an addition to a project app's data path, never the whole of it. Every agent can read and write files and run `sqlite3`, so for data stored in the project the data itself, the contract in the plugin's `AGENTS.md` and a report script are what every agent reaches; the tools give the agents that have them a safer, validated way to do the same. See [Patterns → Write the data contract down](./patterns.md#write-the-data-contract-down).

## Skills

Skills are markdown files a plugin contributes. Daintree exposes them through two tools, `skills.search` and `skills.load`, so a session that has those tools can find and read them through the standard MCP protocol. Not every session does: see [Who reaches skills](#who-reaches-skills). (The `.claude/skills` paths in `SlashCommandService` are an unrelated Claude-native slash-command feature.)

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

**Frontmatter:** only `description` is read — the one-sentence summary `skills.search` returns and searches. Other keys, such as the `applies_to` and `examples` older examples showed, are accepted and ignored: nothing filters or ranks on them, so put the words an agent would search for in the manifest's `triggers` instead. A file with no frontmatter, or frontmatter that does not parse as YAML, keeps its skill with no description.

Everything after the frontmatter is the skill body — the text that gets injected into the agent's context when it invokes the skill.

**Limits:**

- At most 50 skills per plugin, and 50 `triggers` per skill; a manifest over either is rejected.
- Each file is read once, when the plugin loads. A file over 512 KiB, one that is not a regular file, or one that resolves outside the plugin directory is skipped with a warning; the plugin's other skills still load.

### How agents invoke skills

Two tools serve skills, with the same names on Daintree's built-in MCP server and on a plugin's own server:

- `skills.search({ query?, limit? })` — searches ids, names, triggers, and descriptions, returning matching skill IDs and summaries. Omit or pass an empty `query` to list skills unfiltered. `limit` defaults to 20 and cannot exceed 50, and the result does not say when more exist.
- `skills.load({ id })` — returns the full markdown body of a specific skill. An unknown id fails.

Agents use these the same way they'd use any MCP tool. A typical flow:

1. User says "apply TDD to this feature"
2. Agent calls `skills.search("tdd")`
3. Receives a match for `acme.workflows.tdd-workflow` with description
4. Calls `skills.load("acme.workflows.tdd-workflow")`
5. Incorporates the markdown body into its plan

This keeps Daintree's skill system compatible with any agent that speaks MCP and has the two tools — no Daintree-specific prompt engineering needed.

### Who reaches skills

A plugin with an [agent MCP server](#one-server-per-plugin) — one that declares a database or an `agentMcp` endpoint — serves its own skills there, as host tools that read only that plugin's skill files and never start its code. Every agent handed the plugin's server gets its skills with it — at **Read only** for a plugin with a database, and at **Read and write** for one with only an `agentMcp` endpoint, which **Read only** does not serve — so this is the route to rely on for teaching agents your tools.

`skills.search` and `skills.load` on Daintree's own MCP server — the orchestration server — search every plugin's skills at once, and sit in its Full tool set, not its Core one (`shared/config/helpAssistantTierAllowlists.ts`). A skills-only plugin reaches agents through these alone. Daintree's MCP server must be enabled (Settings → MCP server) for any of these:

| Session | Has the skill tools |
| --- | --- |
| A terminal agent in a project whose Daintree MCP tool set (Project settings → General → Agent integrations) is **Full**, launched by a CLI in the [launch table](#reaching-an-agent) | Yes |
| The same agent in a project set to **Core** | Listed, but a call asks the user for approval unless they have allowed that tool for the session |
| The same agent in a project set to **Off**, the default for every project | No — the agent is not handed Daintree's server at all |
| The in-app Daintree Assistant with its tool set at **Full** | Yes; at **Core**, its default, it does not see them |
| An external MCP client connected with an API key | Yes |

So in a project left at its defaults, no terminal agent reaches a skill through Daintree's server, and a plugin's own server reaches only the agents of projects that gave it access. Write a skill for the sessions that do, and put anything every agent working on the project must know in its `AGENTS.md` as well.

A [project plugin](./project-local.md)'s skills are served only to sessions bound to its own project, on either server: a terminal agent launched there, an external client connected with that project's workspace selector, or the Daintree Assistant open in that project. Another project's sessions never see them, and neither does a session bound to no project. Their ids carry the plugin's instance key (`project__<project id>__acme.ledger.reconcile`); pass back the id a search returned. An installed plugin's skills reach every project, under `acme.ledger.reconcile`.

A skill load on a plugin's own server is held to the same 256 KiB result limit as its tools, so keep a skill well under that if agents should read it there.

## When to use which

| I want to… | Use |
| --- | --- |
| Give an agent in a Daintree terminal a new tool that does something | Agent MCP endpoint (`agentMcp`) |
| Let agents read your plugin's SQLite data | Declare it in `contributes.databases` — the plugin's server gets `database_schema` and `database_query` with no code |
| Give agents a specific read, such as a month's total | A query declared on the database (`queries`), served as its own tool with no code |
| Let agents make a write one statement can express | A write query declared on the database (`"mode": "write"`), checked by your schema's constraints and triggers |
| Let agents write data whose rules need code | Agent MCP endpoint tools that enforce them, beside the database tools |
| Ship an existing stdio MCP server for Daintree to supervise, reachable only through the `pluginMcp` IPC and never by terminal agents | MCP server (`mcpServers`) |
| Teach the agent a methodology or rubric | Skill |
| Let terminal agents reach an external API (Linear, Jira, Sentry) | Agent MCP endpoint, calling the API from your plugin's `main` |
| Provide a checklist or step-by-step | Skill |
| Share knowledge that travels cleanly across projects | Skill |
| Ship a tool with a project, committed to its repository | Agent MCP endpoint, with skills beside it to teach agents how to use it — `scope: "project"` plugins may declare both, but not `mcpServers` |
| Hand one record — a card, a message — to an agent for the user to instruct | `host.sendToAgent` or a drag, not MCP — see [Patterns → Hand work to an agent](./patterns.md#hand-work-to-an-agent) |

Plugins often combine them — for example, a Linear plugin might serve terminal agents its issue tools through an agent MCP endpoint and ship a skill that teaches the agent the team's preferred ticket planning format.

## What Daintree does not do

- Does not provide a "PreToolUse/PostToolUse hook" contribution point, and no contribution intercepts an agent's tool calls: an agent MCP endpoint serves your own tools and never sees the agent's calls to anything else. This is deliberate — it keeps the extension model uniform and reuses the MCP ecosystem.
- Does not proxy a plugin's own MCP server to terminal agents. An `agentMcp` endpoint's tools are registered in-process through the host API; there is no mode that forwards an agent to a server the plugin runs.
- Does not expose a subagent spawning API. Daintree creates parallel agents natively. Plugins that want to coordinate multiple agents use MCP and skills to direct Daintree's orchestration, not a dedicated subagent contribution.
- Does not allow a plugin to replace the agent entirely. Agent providers are configured at the Daintree level (OpenAI-compatible base URLs), not through plugins.
