import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { PersistedStoreInfoSchema } from "./schemas";
import { McpSurfaceResultSchema } from "@shared/types/mcpSurface";
import { McpGetSchemaResultSchema } from "@shared/types/mcpTargetPolicy";
import {
  ActionsGetSchemaArgsSchema,
  ActionsListArgsSchema,
  ActionsSearchArgsSchema,
} from "@shared/utils/actionIntrospection";

export function registerIntrospectionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List actions",
    description:
      "List actions a page at a time, filtered by category or substring, to walk a domain; search instead to find a capability by intent. Entries omit schemas, so fetch the schema before dispatching. Ordering is stable across pages.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: ActionsListArgsSchema,
    resultSchema: z.object({
      actions: z.array(z.unknown()),
      total: z.number().int().nonnegative(),
      limit: z.number().int(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { runActionsList } = await import("./introspectionActions.impl");
      return runActionsList(args, ctx);
    },
  }));

  // Registered here purely for manifest registration — schema, description,
  // tier, and audit metadata. Execution is short-circuited in the MCP CallTool
  // handler (electron/services/mcp-server/sessionServer.ts) and runs against the
  // main process, because the caller's authorization tier exists only there:
  // the renderer has no idea which MCP session dispatched it. Same pattern as
  // `skills.search`. `run()` throws if the renderer ever invokes it directly.
  actions.set("mcp.surface", () => ({
    id: "mcp.surface",
    title: "Get MCP surface",
    description:
      "Report this session's tool surface as data: its tier, a stable hash, and per-tool tier, kind, read-only and idempotency hints and deprecation. Call once at startup to check it matches what this client expects, then compare the hash to detect drift.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    mcpOutputSchema: true,
    resultSchema: McpSurfaceResultSchema,
    run: async () => {
      throw new Error(
        "mcp.surface must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("actions.getContext", () => ({
    id: "actions.getContext",
    title: "Get action context",
    description:
      "Snapshot what the user has open: active project, worktree, focused terminal and panel state. Call first to resolve an implicit 'current' target. A missing field means nothing is selected. Can fail early in a session, before the worktree view initialises.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    resultSchema: z.object({
      projectId: z.string().optional(),
      projectName: z.string().optional(),
      projectPath: z.string().optional(),
      activeWorktreeId: z.string().optional(),
      activeWorktreeName: z.string().optional(),
      activeWorktreePath: z.string().optional(),
      activeWorktreeBranch: z.string().optional(),
      activeWorktreeIsMain: z.boolean().optional(),
      focusedWorktreeId: z.string().optional(),
      focusedTerminalId: z.string().optional(),
      focusedTerminalKind: z.string().optional(),
      focusedTerminalTitle: z.string().optional(),
      terminalCount: z.number(),
      worktreeCount: z.number(),
    }),
    run: async () => {
      const { runActionsGetContext } = await import("./introspectionActions.impl");
      return runActionsGetContext();
    },
  }));

  actions.set("actions.persistedStores", () => ({
    id: "actions.persistedStores",
    title: "List persisted stores",
    description:
      "List persisted renderer stores with storage key, version, migration flags, size, and parse status.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    // Genuinely off the MCP surface: this id is in no tier allowlist, so it is
    // neither dispatchable nor grantable (httpLifecycle.ts). `hidden` states
    // that plainly instead of implying it is one search away (#11585).
    mcpVisibility: "hidden",
    resultSchema: z.object({
      storeCount: z.number(),
      stores: z.array(PersistedStoreInfoSchema),
    }),
    run: async () => {
      const { runActionsPersistedStores } = await import("./introspectionActions.impl");
      return runActionsPersistedStores();
    },
  }));

  actions.set("actions.search", () => ({
    id: "actions.search",
    title: "Search actions",
    description:
      "Find actions by describing what you want to do, ranked by match. Start here, then fetch the chosen action's schema before dispatching. Results omit schemas; no match returns an empty list, not a failure.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: ActionsSearchArgsSchema,
    examples: [
      {
        args: { query: "terminal output" },
        description: "Find actions related to reading terminal output",
      },
      {
        args: { query: "list worktrees", limit: 5 },
        description: "Find the top 5 worktree-listing actions",
      },
    ],
    resultSchema: z.object({
      totalMatches: z.number().int().nonnegative(),
      results: z.array(z.unknown()),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { runActionsSearch } = await import("./introspectionActions.impl");
      return runActionsSearch(args, ctx);
    },
  }));

  actions.set("actions.getSchema", () => ({
    id: "actions.getSchema",
    title: "Get action schema",
    description:
      "Fetch one action's manifest entry: its arguments, result shape, and whether this session may call it (tier, confirmation). Use after search, before dispatching. An unknown, hidden or restricted id returns a structured failure, not an error.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: ActionsGetSchemaArgsSchema,
    examples: [
      {
        args: { actionId: "terminal.getStatus" },
        description:
          "Inspect the input and output schema of a terminal status tool before calling it",
      },
    ],
    // Validated but deliberately NOT advertised as an MCP `outputSchema`. It
    // would be the more useful contract — clients AJV-validate
    // `structuredContent` against an advertised schema — but this tool is on
    // `MCP_EXTERNAL_TIER_TOOLS`, where the emitted JSON Schema measured 1,611
    // bytes past `mcpWireBudget`'s 43,000-byte external ceiling. That is ~4% of
    // the whole third-party surface spent on one introspection tool's return
    // shape, and the policy record rides the text result either way. Revisit if
    // that budget ever gains real headroom; do not raise the ratchet for it.
    resultSchema: McpGetSchemaResultSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const { runActionsGetSchema } = await import("./introspectionActions.impl");
      return runActionsGetSchema(args, ctx);
    },
  }));
}
