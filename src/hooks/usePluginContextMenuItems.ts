import { useEffect, useMemo } from "react";
import type { ContextMenuLocation } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { evaluateWhenClause } from "@shared/utils/whenClause";
import {
  usePluginContextMenuItemsStore,
  type PluginContextMenuItemEntry,
} from "@/store/pluginContextMenuItemsStore";
import { useChromeWhenContext } from "@/hooks/useChromeWhenContext";

export type { PluginContextMenuItemEntry };

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
 * here rather than in the shared store. Every key of the shared chrome context
 * is visible too (`useChromeWhenContext`) — plugin `host.setContext` keys under
 * their manifest name and the host's project facts; the caller's surface keys
 * win any clash.
 */
export function usePluginContextMenuItems(
  location: ContextMenuLocation,
  ctx?: WhenClauseContext
): PluginContextMenuItemEntry[] {
  const entries = usePluginContextMenuItemsStore((s) => s.entries);
  const init = usePluginContextMenuItemsStore((s) => s.init);
  const chromeContext = useChromeWhenContext();

  useEffect(() => {
    init();
  }, [init]);

  return useMemo(() => {
    const context = ctx ? { ...chromeContext, ...ctx } : chromeContext;
    return entries.filter(
      (entry) => entry.item.location === location && evaluateWhenClause(entry.item.when, context)
    );
  }, [entries, location, ctx, chromeContext]);
}
