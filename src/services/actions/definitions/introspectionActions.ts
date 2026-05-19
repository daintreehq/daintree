import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionManifestEntry } from "@shared/types/actions";
import { z } from "zod";
import { PersistedStoreInfoSchema } from "./schemas";
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
    title: "List Actions",
    description:
      "List available actions. Filter by category or search. Includes metadata like danger level and enabled state. Prefer `actions.search` for targeted discovery — `actions.list` returns full schemas and is best used as a last-resort escape hatch.",
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
          .describe("Filter by category (e.g. terminal, git, github, panel, portal)"),
        search: z.string().optional().describe("Search in action id, title, or description"),
        enabledOnly: z
          .boolean()
          .optional()
          .describe("Only return enabled actions (default: false)"),
      })
      .optional(),
    resultSchema: z.object({ actions: z.array(z.unknown()) }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { category, search, enabledOnly } =
        (args as { category?: string; search?: string; enabledOnly?: boolean } | undefined) ?? {};
      let manifest = actionService.list(ctx);

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

      return { actions: manifest };
    },
  }));

  actions.set("actions.getContext", () => ({
    id: "actions.getContext",
    title: "Get Action Context",
    description:
      "Get the current UI context: focused terminal, active worktree, current project, and portal state",
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
    mcpVisibility: "discoverable",
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
      "Search available actions by natural-language query or keywords. Returns lightweight matches (id, title, description, category) without full input schemas — use `actions.getSchema` to fetch the full schema for a specific action when you intend to call it.",
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
        .max(100)
        .optional()
        .default(20)
        .describe("Max results (1-100, default 20)"),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { query, limit = 20 } = args as { query: string; limit?: number };
      const manifest = actionService.list(ctx);

      const q = query.toLowerCase();
      const qTerms = q.split(/\s+/).filter((t) => t.length > 0);

      interface ScoredEntry {
        entry: Omit<ActionManifestEntry, "inputSchema" | "outputSchema">;
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
          const { inputSchema: _, outputSchema: __, ...lightweight } = entry;
          scored.push({ entry: lightweight, score });
        }
      }

      scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

      const results = scored.slice(0, Math.min(limit, 100)).map((s) => s.entry);

      return { totalMatches: scored.length, results };
    },
  }));

  actions.set("actions.getSchema", () => ({
    id: "actions.getSchema",
    title: "Get Action Schema",
    description:
      "Fetch the full manifest entry (including inputSchema and outputSchema) for a specific action by ID. Use after `actions.search` to retrieve the schema only for the action you intend to call.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z.object({
      actionId: z.string().min(1).describe("The action ID to fetch the schema for"),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { actionId } = args as { actionId: string };
      const entry = actionService.get(actionId, ctx);

      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No action found with id "${actionId}". Use actions.search to find available actions.`,
          },
        };
      }

      if (entry.mcpVisibility === "hidden") {
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
