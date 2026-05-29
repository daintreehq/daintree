import { useState, useEffect, useMemo } from "react";
import type { ContextMenuContribution, ContextMenuLocation } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { parse, evaluate } from "@shared/utils/whenClause";
import { logWarn } from "@/utils/logger";

export interface PluginContextMenuItemEntry {
  pluginId: string;
  item: ContextMenuContribution;
}

const EMPTY_CONTEXT: WhenClauseContext = {};

/**
 * Pull plugin-contributed context-menu items on mount and keep them in sync
 * with main's authoritative set via push. Same pull-on-mount + push-authoritative
 * shape as `usePluginMenuItems` — see that hook for the `pushReceived` race
 * rationale.
 *
 * Unlike `usePluginMenuItems`, callers pass a `ctx` map captured at menu-open
 * time (e.g. `{ worktreeId }`, `{ panelId, panelKind }`) so `when` clauses that
 * reference the surface's context keys evaluate correctly. An item that
 * references unset keys evaluates to `false` and is hidden — fail-closed. Parse
 * errors are also fail-closed.
 *
 * The `complete` flag on the broadcast is received but has no side effect here
 * (no renderer-local persisted state to sweep); it is plumbed for symmetry with
 * the broadcast contract.
 */
export function usePluginContextMenuItems(
  location: ContextMenuLocation,
  ctx?: WhenClauseContext
): PluginContextMenuItemEntry[] {
  const [entries, setEntries] = useState<PluginContextMenuItemEntry[]>([]);

  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .contextMenuItems()
      .then((items) => {
        if (disposed) return;
        if (pushReceived) return;
        setEntries(items);
      })
      .catch((err: unknown) => {
        logWarn("[PluginContextMenuItems] Failed to fetch initial plugin context menu items", {
          error: err,
        });
      });

    const cleanup = electron.plugin.onContextMenuItemsChanged((payload) => {
      if (disposed) return;
      pushReceived = true;
      setEntries(payload.items);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return useMemo(() => {
    const context = ctx ?? EMPTY_CONTEXT;
    return entries.filter((entry) => {
      if (entry.item.location !== location) return false;
      const whenExpr = entry.item.when;
      if (!whenExpr) return true;
      try {
        return evaluate(parse(whenExpr), context);
      } catch {
        return false;
      }
    });
  }, [entries, location, ctx]);
}
