import { useEffect, useMemo } from "react";
import type { ContextMenuLocation } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { parse, evaluate } from "@shared/utils/whenClause";
import {
  usePluginContextMenuItemsStore,
  type PluginContextMenuItemEntry,
} from "@/store/pluginContextMenuItemsStore";

export type { PluginContextMenuItemEntry };

const EMPTY_CONTEXT: WhenClauseContext = {};

/**
 * Plugin-contributed context-menu items for `location`, filtered to the caller's
 * surface. The pull-on-mount + push-authoritative shared state lives in
 * `pluginContextMenuItemsStore` (one IPC round-trip, one listener for the whole
 * renderer); this hook only initializes that store and derives a filtered view.
 *
 * Callers pass a `ctx` map captured at menu-open time (e.g. `{ worktreeId }`,
 * `{ panelId, panelKind }`) so `when` clauses that reference the surface's
 * context keys evaluate correctly. An item that references unset keys evaluates
 * to `false` and is hidden — fail-closed. Parse errors are also fail-closed.
 * Because the context is consumer-specific, the `when`-clause evaluation stays
 * here rather than in the shared store.
 */
export function usePluginContextMenuItems(
  location: ContextMenuLocation,
  ctx?: WhenClauseContext
): PluginContextMenuItemEntry[] {
  const entries = usePluginContextMenuItemsStore((s) => s.entries);
  const init = usePluginContextMenuItemsStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

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
