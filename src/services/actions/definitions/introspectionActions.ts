import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionManifestEntry } from "@shared/types/actions";
import { z } from "zod";
import { PersistedStoreInfoSchema } from "./schemas";
import {
  ACTIONS_LIST_DEFAULT_LIMIT,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
} from "@shared/config/mcpIntrospection";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePortalStore } from "@/store/portalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { listPersistedStores } from "@/store/persistence/persistedStoreRegistry";
import { readLocalStorageItemSafely } from "@/store/persistence/safeStorage";

// Page bounds for actions.list, shared with the main-process tier filter so
// the advertised default can never drift from the applied one (#11529) nor
// from the window main walks to collect the full match set (#11525).
const DEFAULT_LIST_LIMIT = ACTIONS_LIST_DEFAULT_LIMIT;
const MAX_LIST_LIMIT = ACTIONS_LIST_MAX_LIMIT;

export function registerIntrospectionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List Actions",
    description:
      "Enumerate the available actions as lightweight entries, filtered by domain or substring and returned a page at a time. Use ranked search instead when looking for a capability by intent; use this when the goal is to walk a domain systematically. Entries omit argument and result schemas to stay small — fetch one action's schema before dispatching it. Ordering is stable, so paging cannot skip or repeat entries.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z
      .object({
        category: z
          .string()
          .optional()
          .describe("Filter by exact category (e.g. terminal, worktree, forge, git, portal)"),
        search: z.string().optional().describe("Search in action id, title, or description"),
        enabledOnly: z
          .boolean()
          .optional()
          .describe("Only return enabled actions (default: false)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .default(DEFAULT_LIST_LIMIT)
          .describe(`Max actions to return (1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Number of matching actions to skip (default: 0)"),
      })
      .optional(),
    resultSchema: z.object({
      actions: z.array(z.unknown()),
      total: z.number().int().nonnegative(),
      limit: z.number().int(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const {
        category,
        search,
        enabledOnly,
        limit = DEFAULT_LIST_LIMIT,
        offset = 0,
      } = (args as
        | {
            category?: string;
            search?: string;
            enabledOnly?: boolean;
            limit?: number;
            offset?: number;
          }
        | undefined) ?? {};
      let manifest = actionService.list(ctx, { includeSchemas: false });
      manifest = manifest.filter((entry) => entry.mcpVisibility !== "hidden");

      if (category) {
        manifest = manifest.filter((a) => a.category === category);
      }
      if (search) {
        const q = search.toLowerCase();
        manifest = manifest.filter(
          (a) =>
            (a.id ?? "").toLowerCase().includes(q) ||
            (a.title ?? "").toLowerCase().includes(q) ||
            (a.description ?? "").toLowerCase().includes(q)
        );
      }
      if (enabledOnly) {
        manifest = manifest.filter((a) => a.enabled);
      }

      // Count after filtering but before paging so `total`/`hasMore` describe
      // the whole match set, not the slice the caller happens to be holding.
      const total = manifest.length;
      // Sort before slicing: the registry is a Map, and re-registering a plugin
      // action (usePluginActions replaces any whose descriptor changed) moves it
      // to the end of insertion order. An offset walk over that order could
      // repeat one entry and skip another. Compared by code unit rather than
      // localeCompare so page boundaries don't shift with the host locale —
      // ids are opaque ASCII identifiers, so collation buys nothing here.
      manifest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const page = manifest.slice(offset, offset + limit);

      return {
        actions: page,
        total,
        limit,
        offset,
        hasMore: offset + page.length < total,
      };
    },
  }));

  actions.set("actions.getContext", () => ({
    id: "actions.getContext",
    title: "Get Action Context",
    description:
      "Snapshot what the user currently has open — active project, worktree, focused terminal, and panel state. Call this first to resolve an implicit 'current' target before an action that needs an explicit id. Anything not focused or active is simply absent, so treat a missing field as nothing being selected. It can fail early in a session, before the worktree view store has initialised.",
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
    title: "List Persisted Stores",
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
    title: "Search Actions",
    description:
      "Find actions by describing what you want to do, ranked by how well each matches. This is the discovery path: start here, then fetch the chosen action's schema before dispatching it. Use the plain listing instead when walking a domain systematically rather than searching by intent. Results omit argument and result schemas to stay small, and matching nothing returns an empty list rather than failing.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z.object({
      query: z
        .string()
        .min(1)
        .refine((s) => s.trim().length > 0, "must contain non-whitespace text")
        .describe("Natural-language query or keywords to search for"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(ACTIONS_SEARCH_MAX_LIMIT)
        .optional()
        .default(ACTIONS_SEARCH_DEFAULT_LIMIT)
        .describe(
          `Max results (1-${ACTIONS_SEARCH_MAX_LIMIT}, default ${ACTIONS_SEARCH_DEFAULT_LIMIT})`
        ),
    }),
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
      const { query, limit = ACTIONS_SEARCH_DEFAULT_LIMIT } = args as {
        query: string;
        limit?: number;
      };
      const manifest = actionService.list(ctx, { includeSchemas: false });

      const q = query.toLowerCase();
      const qTerms = q.split(/\s+/).filter((t) => t.length > 0);

      interface ScoredEntry {
        entry: ActionManifestEntry;
        score: number;
      }

      const scored: ScoredEntry[] = [];

      for (const entry of manifest) {
        if (entry.mcpVisibility === "hidden") continue;

        const id = (entry.id ?? "").toLowerCase();
        const title = (entry.title ?? "").toLowerCase();
        const description = (entry.description ?? "").toLowerCase();
        const category = (entry.category ?? "").toLowerCase();
        const keywords = (entry.keywords ?? []).join(" ").toLowerCase();

        let score = 0;

        for (const term of qTerms) {
          if (id === term) {
            score += 50;
          } else if (id.includes(term)) {
            score += 25;
          }
          if (title.includes(term)) {
            score += 15;
          }
          if (keywords.includes(term)) {
            score += 8;
          }
          if (description.includes(term)) {
            score += 4;
          }
          if (category.includes(term)) {
            score += 2;
          }
        }

        if (score > 0) {
          scored.push({ entry, score });
        }
      }

      scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

      const results = scored
        .slice(0, Math.min(limit, ACTIONS_SEARCH_MAX_LIMIT))
        .map((s) => s.entry);

      return { totalMatches: scored.length, results };
    },
  }));

  actions.set("actions.getSchema", () => ({
    id: "actions.getSchema",
    title: "Get Action Schema",
    description:
      "Fetch one action's full manifest entry, including the exact arguments it accepts and the shape it returns. Use this after finding a candidate by search or listing, before dispatching it, so the arguments are known rather than guessed. An unknown, hidden or restricted id comes back as a structured failure in the result rather than as a thrown error.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z.object({
      actionId: z
        .string()
        .min(1)
        .describe(
          "Identifies the action to inspect, using an id from a registry search or listing. This is a Daintree action id passed as a value, not the name of a tool to call."
        ),
    }),
    examples: [
      {
        args: { actionId: "terminal.getStatus" },
        description:
          "Inspect the input and output schema of a terminal status tool before calling it",
      },
    ],
    resultSchema: z.union([
      z.object({ ok: z.literal(true), entry: z.unknown() }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ]),
    run: async (args: unknown, ctx: ActionContext) => {
      const { actionId } = args as { actionId: string };
      const entry = actionService.get(actionId, ctx);

      if (!entry || entry.mcpVisibility === "hidden" || entry.danger === "restricted") {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No action found with id "${actionId}". Use actions.search to find available actions.`,
          },
        };
      }

      return { ok: true, entry };
    },
  }));
}
