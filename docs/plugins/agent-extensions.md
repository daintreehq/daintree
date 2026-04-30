# Agent Extensions

Daintree is an orchestration layer for AI coding agents. Plugins extend what those agents can do in two ways:

- **MCP servers** — the plugin ships a Model Context Protocol server. Agents connected to Daintree discover and call its tools.
- **Skills** — the plugin ships markdown skill files that become part of Daintree's own MCP server. Agents access them through the standard MCP connection.

Which you choose depends on what the extension needs to do. MCP servers can run arbitrary code (API calls, shell commands, subprocess orchestration). Skills are pure declarative knowledge — prompt snippets, workflow instructions, rubrics — injected into the agent's context on demand.

## MCP servers

Daintree supervises any MCP server a plugin ships. It spawns the process lazily, manages lifecycle, exposes tools to agents, and cleans up on Daintree exit.

### Manifest

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

| Field     | Required | Notes                                                                                                                                                             |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | yes      | Namespaced at runtime as `{pluginId}.{id}`.                                                                                                                       |
| `name`    | yes      | Display name in the agent's tool list and Daintree UI.                                                                                                            |
| `command` | yes      | Executable. Relative paths resolve inside the plugin directory. Absolute paths and bare commands (`node`, `python`, `npx`, `uv`) work too.                        |
| `args`    | no       | Argv after the command.                                                                                                                                           |
| `env`     | no       | Environment variables. Values support the `${settings:settingId}` syntax, which resolves to the current value of the plugin's setting with that ID at spawn time. |

**Intentionally excluded:** remote transports (no `url` field), explicit transport declarations (stdio is inferred from `command`'s presence), per-server working directories, restart policies. Shape deliberately matches the Claude Desktop / Cursor MCP config format — authors shipping the same server as a standalone Claude Desktop extension can copy their config verbatim.

### Lifecycle

Daintree spawns MCP servers **on first use**, not at plugin activation. This avoids the well-documented issue where IDEs with many installed MCP servers accumulate subprocesses and leak memory over time.

1. User opens an agent session.
2. Daintree enumerates all registered MCP servers (built-in + user-configured + plugin-contributed) but does not yet spawn them.
3. Agent runs; if it tries to call a tool from a specific server, Daintree spawns that server, waits for handshake, forwards the call.
4. The server stays running for the rest of the session.
5. When the agent session ends (or Daintree exits), Daintree sends SIGTERM, then SIGKILL after a short grace period.

**Tool discovery:** Daintree queries each server's tool list lazily as well. The list is fetched on first spawn and cached. A server that ships with 40 tools won't dump 40 schemas into the agent's context window unless the agent asks for them — Daintree uses a search-based discovery pattern so only the tools the agent actually calls land in its context.

**Crash handling:** if a server process dies unexpectedly, Daintree retries with exponential backoff (1s, 2s, 4s, 8s up to 30s). If 3 consecutive starts fail within 60 seconds, the server is marked degraded and further tool calls return a structured error until manual restart.

### Writing an MCP server for Daintree

MCP servers are standard per the [Model Context Protocol spec](https://modelcontextprotocol.io). Daintree is a standard MCP client. You can use any MCP SDK (TypeScript, Python, Rust) to implement one.

Minimal Node server:

```ts
// dist/mcp/linear-server.js
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";

const server = new Server({ name: "linear", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "list_issues",
      description: "List Linear issues assigned to the current user.",
      inputSchema: {
        type: "object",
        properties: { state: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "list_issues") {
    const issues = await fetchLinear(process.env.LINEAR_API_KEY);
    return { content: [{ type: "text", text: JSON.stringify(issues) }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

Bundle with your plugin's Vite build (as a separate entry — MCP servers run in a subprocess, not in Daintree's renderer).

### Cost considerations

Tool definitions consume tokens. An MCP server exposing 40 tools, each with a detailed JSON schema description, can easily consume 10–30K tokens of context just to be "available" to the agent. The industry has moved toward lazy tool discovery — Daintree does the same — but you should still:

- Keep tool descriptions terse and specific
- Return compact results (agents don't need to see the full database dump — just what answers the question)
- Use `structuredContent` for rich data the UI can render at zero token cost to the agent

See [Architecture → MCP supervisor](./architecture.md#mcp-supervisor) for how Daintree mitigates context bloat.

## Skills

Skills are markdown files a plugin contributes. Daintree's built-in MCP server exposes them as tools. Any agent running in Daintree — through a terminal, through the orchestrated assistant, anywhere — can invoke them through the standard MCP protocol.

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

| Field      | Required | Notes                                                                                        |
| ---------- | -------- | -------------------------------------------------------------------------------------------- |
| `id`       | yes      | Namespaced at runtime as `{pluginId}.{id}`.                                                  |
| `name`     | yes      | Human label.                                                                                 |
| `path`     | yes      | Markdown file, relative to the plugin directory.                                             |
| `triggers` | no       | Phrase fragments that help agents discover the skill in Daintree's MCP `skills/search` tool. |

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

Write the smallest possible failing test that describes the behavior.
Run the test suite — it must fail for the expected reason.

## 2. Green

Write the minimum code needed to make the test pass.
Don't refactor yet.

## 3. Refactor

Clean up the code while keeping the test green.
Extract helpers, rename for clarity, eliminate duplication.

## When to stop

One feature = one Red-Green-Refactor cycle.
Never skip Red — a test that's never seen a failure state isn't a test.
```

**Frontmatter:**

- `description` — one-sentence summary surfaced in skill-discovery results.
- `applies_to` — optional filter hints. Agents use this to decide relevance.
- `examples` — optional list of prompt examples that should invoke this skill.

Everything after the frontmatter is the skill body — the text that gets injected into the agent's context when it invokes the skill.

### How agents invoke skills

Daintree's built-in MCP server exposes two tools for skills:

- `skills/search(query)` — searches triggers and descriptions, returns matching skill IDs and summaries
- `skills/load(id)` — returns the full markdown body of a specific skill

Agents use these the same way they'd use any MCP tool. A typical flow:

1. User says "apply TDD to this feature"
2. Agent calls `skills/search("tdd")`
3. Receives a match for `acme.workflows.tdd-workflow` with description
4. Calls `skills/load("acme.workflows.tdd-workflow")`
5. Incorporates the markdown body into its plan

This keeps Daintree's skill system compatible with any agent that speaks MCP — no Daintree-specific prompt engineering needed.

## When to use which

| I want to…                                              | Use                                                  |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Give the agent a new tool that does something           | MCP server                                           |
| Teach the agent a methodology or rubric                 | Skill                                                |
| Wrap an external API (Linear, Jira, Sentry)             | MCP server                                           |
| Provide a checklist or step-by-step                     | Skill                                                |
| Do anything that requires secret credentials at runtime | MCP server                                           |
| Share knowledge that travels cleanly across projects    | Skill                                                |
| Intercept or modify agent tool calls                    | MCP server (the plugin's MCP server acts as a proxy) |

Plugins often ship both — for example, a Linear plugin might ship an MCP server that exposes Linear's API and a skill that teaches the agent the team's preferred ticket planning format.

## What Daintree does not do

- Does not provide a "PreToolUse/PostToolUse hook" contribution point. If you need to intercept tool calls, your plugin's MCP server can mediate them. This is deliberate — it keeps the extension model uniform and reuses the MCP ecosystem.
- Does not expose a subagent spawning API. Daintree creates parallel agents natively. Plugins that want to coordinate multiple agents use MCP and skills to direct Daintree's orchestration, not a dedicated subagent contribution.
- Does not allow a plugin to replace the agent entirely. Agent providers are configured at the Daintree level (OpenAI-compatible base URLs), not through plugins.
