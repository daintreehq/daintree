import { useEffect, useState } from "react";
import { Plug, AlertCircle } from "lucide-react";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { LoadedPluginInfo } from "@shared/types/plugin";

/** Enabled plugins first, then alphabetically by display name. */
function sortPlugins(list: readonly LoadedPluginInfo[]): LoadedPluginInfo[] {
  return [...list].sort((a, b) => {
    const byEnabled = Number(a.disabled ?? false) - Number(b.disabled ?? false);
    if (byEnabled !== 0) return byEnabled;
    const aName = a.manifest.displayName ?? a.manifest.name;
    const bName = b.manifest.displayName ?? b.manifest.name;
    return aName.localeCompare(bName);
  });
}

/**
 * Preferences surface for enabling/disabling installed plugins (#9284). Both
 * built-in and user-installed plugins can be turned off; the toggle persists to
 * `plugins.disabled` in the store and takes effect on next launch. The switch
 * reflects the persisted (desired) state and a "Restart required" badge appears
 * whenever that diverges from what's actually running this session — both are
 * supplied by `listPlugins()` so they survive a tab remount. The badge is the
 * ambient recovery cue, so no toast is emitted.
 */
export function PluginsTab() {
  const [plugins, setPlugins] = useState<LoadedPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useSettingsTabValidation("plugins", Boolean(error));

  useEffect(() => {
    let cancelled = false;
    window.electron.plugin
      .list()
      .then((list) => {
        if (cancelled) return;
        setPlugins(sortPlugins(list));
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatErrorMessage(err, "Failed to load plugins"));
        logError("Failed to load plugins", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    if (pending.has(id)) return;
    const next = plugin.disabled === true; // currently disabled → enabling
    const before = plugins;

    setPending((prev) => new Set(prev).add(id));
    // Optimistic flip: a single toggle always flips both the desired state and
    // the running/desired mismatch, so `pendingRestart` simply inverts.
    setPlugins((prev) =>
      prev.map((p) =>
        p.manifest.name === id ? { ...p, disabled: !next, pendingRestart: !p.pendingRestart } : p
      )
    );
    try {
      setError(null);
      await window.electron.plugin.setEnabled(id, next);
    } catch (err) {
      setPlugins(before); // revert the optimistic flip
      setError(formatErrorMessage(err, "Failed to update plugin"));
      logError("Failed to update plugin enabled state", err);
    } finally {
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-daintree-text">Installed plugins</h3>
        <p className="text-xs text-daintree-text/50 mt-1 select-text">
          Turn plugins on or off. Disabling a plugin keeps its settings — changes take effect after
          you restart Daintree.
        </p>
      </div>

      {loading ? (
        showInlineLoading ? (
          <p className="text-xs text-daintree-text/50">Loading…</p>
        ) : null
      ) : plugins.length === 0 ? (
        <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<Plug />}
            title="No plugins installed"
            description="Install a plugin to extend Daintree with panels, commands, and integrations."
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {plugins.map((plugin) => {
            const id = plugin.manifest.name;
            const enabled = plugin.disabled !== true;
            const restartRequired = plugin.pendingRestart === true;
            const label = plugin.manifest.displayName ?? plugin.manifest.name;
            return (
              <SettingsSwitchCard
                key={id}
                icon={Plug}
                title={label}
                subtitle={
                  plugin.manifest.description ??
                  `${plugin.isBuiltin ? "Built-in" : "User"} plugin · v${plugin.manifest.version}`
                }
                isEnabled={enabled}
                onChange={() => void handleToggle(plugin)}
                ariaLabel={`Enable ${label}`}
                disabled={pending.has(id)}
                lifecycleBadge={restartRequired ? "Restart required" : undefined}
              />
            );
          })}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}
    </div>
  );
}
