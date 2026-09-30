import { useCallback, useEffect, useRef, useState } from "react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { getPluginStyleReportForRoots } from "@/services/plugin/pluginStyleContract";
import type { PluginStyleReport } from "@/services/plugin/tailwind/pluginStyleRuntime";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * The plugin style roots in this document that belong to `pluginId` (the
 * runtime instance id). A root is attributed through the panel that hosts it:
 * `ContentPanel` stamps `data-panel-id`, the panel record names its kind, and
 * the kind's `extensionId` is the owning instance. A portal a view mounted
 * outside its panel has no panel to attribute it to, so it is not counted.
 */
export function findPluginStyleRoots(pluginId: string, doc: Document = document): Element[] {
  const panels = getPanelStoreSnapshot()?.panelsById;
  if (!panels) return [];
  const roots: Element[] = [];
  for (const root of doc.querySelectorAll(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`)) {
    const panelId = root.closest("[data-panel-id]")?.getAttribute("data-panel-id");
    if (!panelId) continue;
    const kind = panels[panelId]?.kind;
    if (!kind) continue;
    if (getPanelKindConfig(kind)?.extensionId !== pluginId) continue;
    roots.push(root);
  }
  return roots;
}

export type PluginStyleReportState =
  | { status: "checking" }
  /** None of the plugin's views is mounted in this window, so there is nothing to read. */
  | { status: "no-views" }
  | { status: "ready"; report: PluginStyleReport }
  | { status: "error"; message: string };

// Outside the hook: a try/catch holding conditionals bails React Compiler.
async function runCheck(pluginId: string): Promise<PluginStyleReportState> {
  try {
    const report = await getPluginStyleReportForRoots(findPluginStyleRoots(pluginId));
    return report ? { status: "ready", report } : { status: "no-views" };
  } catch (error) {
    return {
      status: "error",
      message: formatErrorMessage(error, "Couldn't check this plugin's styles"),
    };
  }
}

/**
 * Checks, on demand, which classes in `pluginId`'s mounted views compile to
 * nothing. Reads once on mount and again on `recheck()`; it deliberately does
 * not watch the DOM, since a report that rewrote itself as the user typed in
 * the plugin would be unreadable.
 */
export function usePluginStyleReport(pluginId: string): {
  state: PluginStyleReportState;
  recheck: () => void;
} {
  const [state, setState] = useState<PluginStyleReportState>({ status: "checking" });
  // Orders overlapping checks: only the newest may write, and nothing may
  // write after unmount.
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const check = useCallback(async () => {
    const request = ++requestRef.current;
    setState({ status: "checking" });
    const next = await runCheck(pluginId);
    if (mountedRef.current && request === requestRef.current) setState(next);
  }, [pluginId]);

  useEffect(() => {
    mountedRef.current = true;
    void check();
    return () => {
      mountedRef.current = false;
    };
  }, [check]);

  return { state, recheck: () => void check() };
}
