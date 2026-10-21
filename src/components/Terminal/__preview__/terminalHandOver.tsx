import "./terminalHandOverShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useTerminalAdoptionStore } from "@/store/terminalAdoptionStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { TerminalHandOverDialog } from "../TerminalHandOver";
import "@/index.css";

/**
 * Standalone visual-review harness for the terminal hand-over: the consent
 * dialog and the "Driven by" chip a handed-over pane wears.
 *
 * The dialog is the real `TerminalHandOverDialog`, naming panes from the real
 * panel store. The chip is judged in the header row it ships in, inside a real
 * `ContentPanel`, with the hand-over seeded into the adoption store the way
 * main's push lands it.
 *
 * Query parameters (the capture spec drives these):
 *   ?theme=<built-in theme id>
 *   ?state=dialog|chip
 *   ?pane=agent|shell         which terminal is handed over (default agent)
 *   ?refuse=already-handed    the confirm comes back refused (see the shims)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const state = params.get("state") ?? "dialog";
const paneKind = params.get("pane") ?? "agent";

const PANE_ID = "t-driven";
const ORCH_ID = "t-orch";
const OTHER_ID = "t-other";
const PANE_WIDTH = 560;
const PANE_HEIGHT = 240;
const NOW = Date.now();
const noop = () => {};

function pty(id: string, title: string, extra: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    location: "grid",
    cwd: "/Users/dev/acme-platform",
    cols: 120,
    rows: 40,
    hasPty: true,
    runtimeStatus: "running",
    ...extra,
  } as PtyPanelData;
}

const driven =
  paneKind === "shell"
    ? pty(PANE_ID, "npm run dev")
    : pty(PANE_ID, "Codex", {
        launchAgentId: "codex",
        detectedAgentId: "codex",
        agentState: "waiting",
        lastStateChange: NOW - 40_000,
        startedAt: NOW - 600_000,
      });
const panels = [
  driven,
  pty(ORCH_ID, "Claude", { launchAgentId: "claude", detectedAgentId: "claude" }),
  pty(OTHER_ID, "Gemini", { launchAgentId: "gemini", detectedAgentId: "gemini" }),
];

usePanelStore.setState({
  panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  panelIds: panels.map((p) => p.id),
} as Partial<ReturnType<typeof usePanelStore.getState>>);
usePluginContextMenuItemsStore.setState({ entries: [], init: noop });
if (state === "chip") {
  useTerminalAdoptionStore
    .getState()
    .applyAdoptions([
      { terminalId: PANE_ID, orchestratorPaneId: ORCH_ID, adoptedAt: NOW - 120_000 },
    ]);
}

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div className="text-text-primary">• Push the release branch to origin?</div>
      <div>&nbsp;&nbsp;1. Yes</div>
      <div>&nbsp;&nbsp;2. No, and tell Codex what to do differently</div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  if (state === "dialog") {
    return (
      <div data-preview-shell className="h-screen w-screen">
        <TerminalHandOverDialog terminalId={PANE_ID} orchestratorPaneId={ORCH_ID} onClose={noop} />
      </div>
    );
  }

  return (
    <div
      data-preview-pane
      className="bg-surface-canvas p-2"
      style={{ width: PANE_WIDTH, height: PANE_HEIGHT }}
    >
      <ContentPanel
        id={PANE_ID}
        title={driven.title}
        kind="terminal"
        isFocused
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        onRestart={noop}
        agentId={driven.launchAgentId}
        detectedAgentId={driven.detectedAgentId}
        agentState={driven.agentState}
        onAddTab={noop}
      >
        <TerminalLines />
      </ContentPanel>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
