import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePortalStore } from "@/store/portalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { listPersistedStores } from "@/store/persistence/persistedStoreRegistry";
import { readLocalStorageItemSafely } from "@/store/persistence/safeStorage";

interface PersistedStoreInfo {
  storeId: string;
  storageKey: string;
  declaredVersion: number | null;
  persistedBlobVersion: number | null;
  hasMigrate: boolean;
  hasMerge: boolean;
  hasPartialize: boolean;
  persistedStateType: string;
  hasPersistedValue: boolean;
  sizeBytes: number;
  parseStatus: "ok" | "missing" | "corrupt";
}

export function registerIntrospectionActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("actions.list", () => ({
    id: "actions.list",
    title: "List Actions",
    description:
      "List available actions. Filter by category or search. Includes metadata like danger level and enabled state.",
    category: "introspection",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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

      return manifest;
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
    run: async () => {
      const registrations = listPersistedStores();
      const stores: PersistedStoreInfo[] = registrations.map((reg) => {
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
}
