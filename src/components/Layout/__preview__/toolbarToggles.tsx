// First, so the bridge shim exists before any store module evaluates.
import "./toolbarShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiagnosticsStore, usePortalStore, useVoiceRecordingStore } from "@/store";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { ToolbarProblemsButton } from "../ToolbarProblemsButton";
import { ToolbarPortalButton } from "../ToolbarPortalButton";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { PluginTrayButton, type PluginToolbarConfigs } from "../PluginTrayButton";
import "@/index.css";

/**
 * Visual-review harness for the toolbar's toggle buttons: their tooltips and
 * the plugin tray menu. Mounts the real components against seeded stores.
 *
 * Query parameters:
 *   ?theme=<id>    built-in theme id (default daintree)
 *   ?state=<name>  one of STATES below (default problems-clean)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const stateName = params.get("state") ?? "problems-clean";

interface State {
  errorCount?: number;
  watcherDegraded?: boolean;
  topologyWatcherDark?: boolean;
  problemsOpen?: boolean;
  portalOpen?: boolean;
  voice?: "recording" | "paused";
}

const STATES: Record<string, State> = {
  "problems-clean": {},
  "problems-errors": { errorCount: 3, watcherDegraded: true },
  "problems-open": { errorCount: 1, topologyWatcherDark: true, problemsOpen: true },
  "portal-closed": {},
  "portal-open": { portalOpen: true },
  "voice-recording": { voice: "recording" },
  "voice-paused": { voice: "paused" },
  tray: {},
};

const state = STATES[stateName] ?? {};

const PLUGIN_CONFIGS: PluginToolbarConfigs = new Map<string, ToolbarButtonConfig>(
  (
    [
      {
        id: "plugin.acme.release.notes",
        label: "Draft release notes",
        iconId: "file-text",
        actionId: "acme.release.notes",
        priority: 1,
        pluginId: "acme.release",
      },
      {
        id: "plugin.acme.release.audit",
        label: "Audit every dependency licence across the monorepo workspaces",
        iconId: "list",
        actionId: "acme.release.audit",
        priority: 2,
        pluginId: "acme.release",
      },
      {
        id: "plugin.linear.issue",
        label: "Open linked issue",
        iconId: "kanban",
        actionId: "linear.issue",
        priority: 1,
        pluginId: "linear",
      },
    ] satisfies ToolbarButtonConfig[]
  ).map((c) => [c.id, c])
);

usePluginRuntimeStore.setState({
  pluginMetaById: new Map([
    ["acme.release", { devMode: false, displayName: "Acme Release", previewToolIds: new Set() }],
    ["linear", { devMode: false, displayName: "Linear", previewToolIds: new Set() }],
  ]),
  refresh: () => {},
});
useToolbarPreferencesStore.setState((s) => ({
  layout: { ...s.layout, pinnedButtons: { "plugin.linear.issue": true } },
}));
useDiagnosticsStore.setState({ isOpen: state.problemsOpen ?? false });
usePortalStore.setState({ isOpen: state.portalOpen ?? false });
if (state.voice) {
  useVoiceRecordingStore.setState({
    isConfigured: true,
    status: state.voice,
    micSignal: "live",
    elapsedSeconds: 42,
    activeTarget: {
      panelId: "voice-elsewhere",
      panelTitle: "claude · release notes",
      projectName: "Daintree",
      worktreeLabel: "main",
    },
  });
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <div data-preview-shell="" className="p-6">
      <div
        role="toolbar"
        aria-label="Main toolbar"
        className="ml-auto flex h-12 w-fit items-center gap-1 rounded-[var(--radius-md)] bg-surface-sidebar px-2"
      >
        <span data-harness-slot="problems" className="inline-flex">
          <ToolbarProblemsButton
            errorCount={state.errorCount ?? 0}
            watcherDegraded={state.watcherDegraded}
            topologyWatcherDark={state.topologyWatcherDark}
            onToggleProblems={() => {}}
          />
        </span>
        <span data-harness-slot="portal" className="inline-flex">
          <ToolbarPortalButton />
        </span>
        {state.voice && (
          <span data-harness-slot="voice" className="inline-flex">
            <VoiceRecordingToolbarButton />
          </span>
        )}
        <span data-harness-slot="tray" className="inline-flex">
          <PluginTrayButton configs={PLUGIN_CONFIGS} />
        </span>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider
        delayDuration={UI_TOOLTIP_DELAY_DURATION}
        skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
        disableHoverableContent
      >
        <App />
      </TooltipProvider>
    </StrictMode>
  );
}
