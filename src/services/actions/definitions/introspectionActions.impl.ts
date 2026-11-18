// The introspection actions' run bodies, loaded on first dispatch by
// introspectionActions.ts, which keeps the metadata every view registers at boot.
// Nothing here may import introspectionActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import type { z } from "zod";
import type { PersistedStoreInfoSchema } from "./schemas";
import type {
  ActionsListArgsSchema,
  ActionsSearchArgsSchema,
} from "@shared/utils/actionIntrospection";
import { listActionManifest, searchActionManifest } from "@shared/utils/actionManifestQueries";
import { ACTIONS_LIST_WALK_LIMIT } from "@shared/config/mcpIntrospection";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { listPersistedStores } from "@/store/persistence/persistedStoreRegistry";
import { readLocalStorageItemSafely } from "@/store/persistence/safeStorage";

export async function runActionsList(args: unknown, ctx: ActionContext) {
  const query = (args as z.infer<typeof ActionsListArgsSchema>) ?? {};
  // Main's own walk (#17036) takes the registry in one page; it pages the
  // caller's permitted set back down itself.
  return listActionManifest(
    actionService.list(ctx, { includeSchemas: false }),
    ctx.actionsListWalk ? { ...query, limit: ACTIONS_LIST_WALK_LIMIT } : query
  );
}

export async function runActionsGetContext() {
  const project = useProjectStore.getState().currentProject;
  const terminalState = usePanelStore.getState();
  const worktreeSelection = useWorktreeSelectionStore.getState();
  const worktrees = getCurrentViewStore().getState().worktrees;

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
    terminalCount: terminalState.panelIds.filter(
      (id) => terminalState.panelsById[id]?.location !== "trash"
    ).length,
    worktreeCount: worktrees.size,
  };
}

export async function runActionsPersistedStores() {
  const registrations = listPersistedStores();
  const stores: z.infer<typeof PersistedStoreInfoSchema>[] = registrations.map((reg) => {
    const options = reg.store.persist.getOptions();
    const storageKey = typeof options.name === "string" ? options.name : "";
    const declaredVersion = typeof options.version === "number" ? options.version : null;

    // storage-key: declared-elsewhere
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
}

export async function runActionsSearch(args: unknown, ctx: ActionContext) {
  const { query, limit } = args as z.infer<typeof ActionsSearchArgsSchema>;
  return searchActionManifest(actionService.list(ctx, { includeSchemas: false }), query, limit);
}

export async function runActionsGetSchema(args: unknown, ctx: ActionContext) {
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
}
