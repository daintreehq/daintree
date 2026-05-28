import { useState, useEffect, useMemo } from "react";
import type { MenuItemContribution, MenuItemLocation } from "@shared/types/plugin";
import { parse, evaluate } from "@shared/utils/whenClause";
import { logWarn } from "@/utils/logger";

export interface PluginMenuItemEntry {
  pluginId: string;
  item: MenuItemContribution;
}

/**
 * Pull plugin-contributed menu items on mount and keep them in sync with
 * main's authoritative set via push. Same pull-on-mount + push-authoritative
 * shape as `usePluginToolbarButtons` — see that hook for the `pushReceived`
 * race rationale.
 *
 * `when` clauses are evaluated synchronously against an empty context. The
 * renderer-side reactive `WhenClauseStore` is not yet wired (no producers call
 * `setWhenContext`), so an item that references unset context keys evaluates
 * to `false` and is hidden — fail-closed. Parse errors are also fail-closed.
 *
 * Unlike toolbar buttons, menu items have no renderer-local persisted state to
 * sweep, so the `complete` flag on the broadcast is received but has no side
 * effect here. It is plumbed for symmetry with the broadcast contract.
 */
export function usePluginMenuItems(location: MenuItemLocation): PluginMenuItemEntry[] {
  const [entries, setEntries] = useState<PluginMenuItemEntry[]>([]);

  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .menuItems()
      .then((items) => {
        if (disposed) return;
        if (pushReceived) return;
        setEntries(items);
      })
      .catch((err: unknown) => {
        logWarn("[PluginMenuItems] Failed to fetch initial plugin menu items", { error: err });
      });

    const cleanup = electron.plugin.onMenuItemsChanged((payload) => {
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
    return entries.filter((entry) => {
      if (entry.item.location !== location) return false;
      const whenExpr = entry.item.when;
      if (!whenExpr) return true;
      try {
        return evaluate(parse(whenExpr), {});
      } catch {
        return false;
      }
    });
  }, [entries, location]);
}
