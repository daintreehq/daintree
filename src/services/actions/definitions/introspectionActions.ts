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
  listActionManifest,
  searchActionManifest,
} from "@shared/utils/actionIntrospection";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePortalStore } from "@/store/portalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { listPersistedStores } from "@/store/persistence/persistedStoreRegistry";
import { readLocalStorageItemSafely } from "@/store/persistence/safeStorage";

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
    run: async (args: unknown, ctx: ActionContext) =>
      listActionManifest(
        actionService.list(ctx, { includeSchemas: false }),
        (args as z.infer<typeof ActionsListArgsSchema>) ?? {}
      ),
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
      portalOpen: z.boolean(),
      portalActiveTabId: z.string().nullable(),
      terminalCount: z.number(),
      worktreeCount: z.number(),
    }),
    run: async () => {
      const project = useProjectStore.getState().currentProject;
      const terminalState = usePanelStore.getState();
      const worktreeSelection = useWorktreeSelectionStore.getState();
      const worktrees = getCurrentViewStore().getState().worktrees;
      const portal = usePortalStore.getState();

      const focusedId = terminalState.focusedId;
      const focusedTerminal = focusedId ? (terminalState.panelsById[focusedId] ?? null) : null;

      const activeWorktreeId = worktreeSelection.activeWorktreeId;
      const activeWorktree = activeWorktreeId ? worktrees.get(activeWorktreeId) : null;

      const ctx: ActionContext = {
        projectId: project?.id,
        projectName: project?.name,
        projectPath: project?.path,
        activeWorktreeId: activeWorktreeId ?? undefined,
        activeWorktreeName: activeWorktree?.name,
        activeWorktreePath: activeWorktree?.path,
        activeWorktreeBranch: activeWorktree?.branch,
        activeWorktreeIsMain: activeWorktree?.isMainWorktree,
        focusedWorktreeId: worktreeSelection.focusedWorktreeId ?? undefined,
        focusedTerminalId: focusedId ?? undefined,
        focusedTerminalKind: focusedTerminal?.kind,
        focusedTerminalTitle: focusedTerminal?.title,
      };

      return {
        ...ctx,
        portalOpen: portal.isOpen,
        portalActiveTabId: portal.activeTabId,
        terminalCount: terminalState.panelIds.filter(
          (id) => terminalState.panelsById[id]?.location !== "trash"
        ).length,
        worktreeCount: worktrees.size,
      };
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
      const registrations = listPersistedStores();
      const stores: z.infer<typeof PersistedStoreInfoSchema>[] = registrations.map((reg) => {
        const options = reg.store.persist.getOptions();
        const storageKey = typeof options.name === "string" ? options.name : "";
        const declaredVersion = typeof options.version === "number" ? options.version : null;

        const raw = storageKey ? readLocalStorageItemSafely(storageKey) : null;
        const hasPersistedValue = raw !== null;
        const sizeBytes = raw !== null ? raw.length * 2 : 0;

        let persistedBlobVersion: number | null = null;
        let parseStatus: "ok" | "missing" | "corrupt" = "missing";
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as { version?: unknown };
            parseStatus = "ok";
            if (typeof parsed?.version === "number") {
              persistedBlobVersion = parsed.version;
            }
          } catch {
            parseStatus = "corrupt";
          }
        }

        return {
          storeId: reg.storeId,
          storageKey,
          declaredVersion,
          persistedBlobVersion,
          hasMigrate: typeof options.migrate === "function",
          hasMerge: typeof options.merge === "function",
          hasPartialize: typeof options.partialize === "function",
          persistedStateType: reg.persistedStateType,
          hasPersistedValue,
          sizeBytes,
          parseStatus,
        };
      });

      return { storeCount: stores.length, stores };
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
      const { query, limit } = args as z.infer<typeof ActionsSearchArgsSchema>;
      return searchActionManifest(actionService.list(ctx, { includeSchemas: false }), query, limit);
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
      const { actionId } = args as { actionId: string };
      const entry = actionService.get(actionId, ctx);

      if (!entry || entry.mcpVisibility === "hidden" || entry.danger === "restricted") {
        return {
          ok: false,
          entry: null,
          policy: null,
          error: {
            code: "NOT_FOUND",
            message: `No action found with id "${actionId}". Use actions.search to find available actions.`,
          },
        };
      }

      // `policy` is main's to fill: this runs in the renderer, which has no
      // session, tier, or grant state to evaluate one against. Main rebuilds
      // this payload in `filterIntrospectionResultForSession` and substitutes
      // the real record there, or denies the read if it cannot build one. The
      // null placeholder is what lets that field stay required-and-nullable in
      // the declared schema rather than optional. `McpGetSchemaWireResultSchema`
      // is the stricter shape a client sees once main has filled it in.
      return { ok: true, entry, policy: null, error: null };
    },
  }));
}
