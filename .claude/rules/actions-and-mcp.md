---
paths:
  - "src/services/actions/**"
  - "src/services/ActionService.ts"
  - "shared/config/actionIds.ts"
  - "shared/types/actions.ts"
  - "electron/services/mcp-server/**"
---

# Actions and the MCP surface

## Adding an action

1. Add the ID to `BUILT_IN_ACTION_IDS` in `shared/config/actionIds.ts`.
2. Write the definition in `src/services/actions/definitions/*.ts`.
3. It auto-registers via `useActionRegistry`.

Types live in `shared/types/actions.ts` — `ActionSource` (including `"plugin"`) and `ActionDanger`. Every destructive action carries the `danger` classification its tier requires; `check:confirm-wiring` verifies the wiring.

## The action manifest is a public contract

The same manifest is the tool surface of the local MCP server, so external agents and the in-app assistant drive the IDE through it under tiered auth (`docs/architecture/mcp-server.md`). Renaming or repurposing an action ID is a breaking change for them, not just an internal refactor.

## MCP authoring budget

Tool descriptions are capped at **400 bytes** and some sit close to it. Use zod `.describe()` on fields rather than growing the tool description.

Output schemas are a hard contract — the SDK validates `structuredContent` with AJV client-side, so a schema that drifts from the payload fails on the client. Only *input* schemas can be safely condensed.

Standard and CI budgets: `docs/architecture/mcp-context-condensation.md`.

## Expose observations, not interpretations

Agent state comes from passive PTY output heuristics and is often wrong. MCP tools and UI surface **what we saw**, never what we concluded from it. `running` is a runtime status, not an agent state.

`dispatchSource` is `"agent"` for every MCP dispatch, so it never tells the in-app assistant from an external client. The authoritative caller class is `sessionOrigin` (`McpSessionOrigin` in `shared/types/ipc/mcpServer.ts`): main resolves it per session and attaches it to every renderer dispatch request, pinned and unpinned, and the caller can never supply it. Read it from the dispatch payload instead of inferring it from `dispatchSource` or building a second channel; detail is in `docs/architecture/mcp-server.md`.
