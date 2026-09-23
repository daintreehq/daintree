import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

/**
 * Plugins settings tab — a thin entry point into the dedicated plugin manager
 * (#9548, #9558). The full management surface (install, enable/disable,
 * uninstall, update check, drag-drop) now lives in the graduated first-class
 * `PluginManagerView`; this tab shows the installed count and opens the manager
 * via the `app.pluginManager` action.
 */
export function PluginsTab() {
  const [count, setCount] = useState<number | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const showInlineLoading = useDeferredLoading(count === null, UI_DOHERTY_THRESHOLD);
  // Opt-in background update check (#10893). `null` until the main-process
  // electron-store value loads; renders OFF while loading so it never implies
  // the feature is on before we know.
  const [backgroundChecksEnabled, setBackgroundChecksEnabled] = useState<boolean | null>(null);
  const [backgroundChecksSaving, setBackgroundChecksSaving] = useState(false);
  const isMountedRef = useRef(true);

  // Re-pull the count when a plugin is installed or uninstalled anywhere so the
  // summary stays accurate while the settings dialog is open (#9285).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electron.plugin
        .list()
        .then((list) => {
          if (cancelled) return;
          setCount(list.length);
          setCountFailed(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // A count of zero would read as "nothing installed"; say it couldn't be read
          // and let the manager, which surfaces the failure itself, take it from there.
          setCountFailed(true);
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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!window.electron?.plugin?.getBackgroundUpdateCheckSettings) {
      // Older preload (e.g. tests) — default to OFF, the persisted default.
      setBackgroundChecksEnabled(false);
      return;
    }
    let cancelled = false;
    window.electron.plugin
      .getBackgroundUpdateCheckSettings()
      .then((result) => {
        if (!cancelled) setBackgroundChecksEnabled(result.enabled);
      })
      .catch((err) => {
        if (cancelled) return;
        logError("Failed to load plugin background update check setting", err);
        setBackgroundChecksEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBackgroundChecksToggle = async () => {
    if (backgroundChecksSaving || backgroundChecksEnabled === null) return;
    if (!window.electron?.plugin?.setBackgroundUpdateCheckSettings) return;
    const prev = backgroundChecksEnabled;
    const next = !prev;
    setBackgroundChecksEnabled(next);
    setBackgroundChecksSaving(true);
    try {
      const result = await window.electron.plugin.setBackgroundUpdateCheckSettings(next);
      if (isMountedRef.current) setBackgroundChecksEnabled(result.enabled);
    } catch (err) {
      logError("Failed to save plugin background update check setting", err);
      if (isMountedRef.current) setBackgroundChecksEnabled(prev);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Background update check preference couldn't be saved.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleBackgroundChecksToggle(),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) setBackgroundChecksSaving(false);
    }
  };

  const openManager = () => {
    void actionService.dispatch("app.pluginManager", undefined, { source: "user" });
  };

  const summary = countFailed
    ? "Couldn't read the installed plugins — the plugin manager shows why"
    : count === null
      ? null
      : count === 0
        ? "No plugins installed yet"
        : `${count} plugin${count === 1 ? "" : "s"} installed`;

  return (
    <div className="space-y-8">
      <SettingsSection
        id="plugins-manage"
        title="Installed plugins"
        description="Extend Daintree with panels, commands, and integrations. Install, enable, and update plugins from the plugin manager."
      >
        <SettingsGroup>
          <SettingsRow
            label="Plugin manager"
            description={
              <span className="block min-h-[1rem]">
                {summary ?? (showInlineLoading ? "Loading…" : "")}
              </span>
            }
            control={
              <Button variant="outline" size="sm" onClick={openManager}>
                Open plugin manager
              </Button>
            }
          />
          <SettingsSwitchCard
            title="Check for plugin updates in the background"
            subtitle="Checks URL-installed plugins about once a day and adds an inbox notification when updates are available"
            isEnabled={backgroundChecksEnabled ?? false}
            onChange={() => void handleBackgroundChecksToggle()}
            disabled={backgroundChecksEnabled === null || backgroundChecksSaving}
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
