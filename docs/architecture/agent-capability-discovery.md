# Agent capability discovery

The terminal completion engine is the local source of truth for both autocomplete and agent automation. `agentCapabilities.search` returns bounded summaries for a terminal, or an explicit agent and worktree; `agentCapabilities.get` re-resolves one selected source and reads bounded usage instructions. Both are read-only actions on the existing MCP surface. Individual user commands and skill bodies are not loaded into the assistant's initial tool inventory.

Use `insertText` (or `invocation.token` from details) verbatim. A Codex skill uses `$name`, a bundled skill uses `$plugin:name`, and Claude skills use `/name`. Labels can differ from tokens. Detail results include argument hints when declared, source revisions and instruction pagination; `startupSupport: "unverified"` is an explicit limit, not permission to invent CLI flags. The agent launcher remains responsible for escaping and launching the CLI.

Catalog revisions bind pagination and selection to agent, worktree, source identity and file metadata. Detail lookup always refreshes discovery; source pages also require the prior source revision. On a revision mismatch, search again with `refresh:true`. Existing CLI sessions may need their own reload: filesystem discovery cannot establish what a running process has loaded. Raw plugin manifests are never returned as instructions because they may contain configuration.

## Coverage audit

This audit describes the declared local adapters, not a claim to have exercised every command in every installed CLI.

| Agent/source | Discovery | Remaining limits |
| --- | --- | --- |
| Claude built-ins, custom Markdown commands and skills | Static catalog plus configured global/user/project directories; YAML frontmatter, non-invocable filtering | Plugin/remote skills and version/session-specific built-ins are not established by a local scan |
| Codex built-ins and skills | Static catalog, system/user skill directories and project `.agents/skills`; `$` invocation; symlinked skill directories | Parent/nested-directory scope and running-session reload state need agent-specific verification |
| Codex plugins and bundled skills | Enabled config entries intersected with cached manifests; namespaced skills; semantic version ordering with `local` preference | Nonstandard manifests and server-resolved apps are not covered |
| Gemini built-ins and custom commands | Static catalog plus configured TOML command directories | No declared skill/extension adapter; no live CLI parity claim |
| Other built-in or custom/plugin agents | Runtime registry accepts their IDs and declared completion sources | Agents without sources return `coverage: "unsupported"`, not an authoritative empty catalog |

All supported local scans report `coverage: "partial"` with explicit warnings. Parser/read failures are surfaced, and arbitrary paths cannot be passed to detail lookup: it resolves a returned capability ID in the supplied context. Broadening coverage belongs in the shared engine/adapters so every consumer benefits.

## Cross-repository contract

`docs/contracts/agent-capabilities.json` is generated from the shared action schemas by `npx tsx scripts/codegen/agent-capabilities.ts`. Action tests compare it to the published definitions. The Assistant CLI captures the same file in `internal/tools/mcpx/testdata/agent_capabilities.json` and tests calls against those actual schemas. Update both in a coordinated change, then update the CLI pins in this repository and the assistant backend.

The CLI classifies the two catalog actions and `slashCommands.list` as reviewed reads. The backend teaches lookup through `tool.search` → `tool.schema` → `daintree.invoke` and keeps exact command tokens and arguments in durable workflow nodes. Each issue advances independently; an async settlement cannot complete a command node with acceptance criteria. Verification and ordinary tool/grant handling still govern subsequent sends. The workflow graph stores progress and advises execution; it does not itself run commands.
