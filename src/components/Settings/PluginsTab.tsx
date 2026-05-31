import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

/**
 * Plugins settings tab — a thin entry point into the dedicated plugin manager
 * (#9548). The full management surface (install, enable/disable, uninstall,
 * update check, drag-drop) now lives in `PluginManagerDialog`; this tab shows
 * the installed count and opens the manager via the `app.pluginManager` action.
 */
export function PluginsTab() {
  const [count, setCount] = useState<number | null>(null);
  const showInlineLoading = useDeferredLoading(count === null, UI_DOHERTY_THRESHOLD);

  // Re-pull the count when a plugin is installed or uninstalled anywhere so the
  // summary stays accurate while the settings dialog is open (#9285).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electron.plugin
        .list()
        .then((list) => {
          if (!cancelled) setCount(list.length);
        })
        .catch((err) => {
          if (cancelled) return;
          // The manager surfaces load failures itself; the summary just stays
          // quiet rather than showing a count it can't trust.
          setCount(0);
          logError("Failed to load plugin count", err);
        });
    };
    load();
    const unsubscribe = window.electron.plugin.onProvenanceChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const openManager = () => {
    void actionService.dispatch("app.pluginManager", undefined, { source: "user" });
  };

  const summary =
    count === null
      ? null
      : count === 0
        ? "No plugins installed yet."
        : `${count} plugin${count === 1 ? "" : "s"} installed.`;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-daintree-text">Plugins</h3>
        <p className="text-xs text-daintree-text/50 mt-1 select-text">
          Extend Daintree with panels, commands, and integrations. Install, enable, and update
          plugins from the plugin manager.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 p-4 rounded-[var(--radius-lg)] border border-daintree-border">
        <div className="flex items-center gap-3 min-w-0">
          <Plug className="w-5 h-5 text-daintree-text/70 shrink-0" aria-hidden="true" />
          <div className="min-w-0 text-left">
            <div className="text-sm font-medium text-daintree-text">Plugin manager</div>
            <div className="text-xs text-daintree-text/60 mt-0.5 min-h-[1rem]">
              {summary ?? (showInlineLoading ? "Loading…" : "")}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={openManager} className="shrink-0">
          Open plugin manager
        </Button>
      </div>
    </div>
  );
}
