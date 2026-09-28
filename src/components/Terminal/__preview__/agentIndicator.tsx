import "./agentIndicatorShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { TerminalAgentIndicator } from "@/components/Terminal/TerminalAgentIndicator";
import "@/index.css";

/**
 * Standalone visual-review harness for a terminal pane's agent state chip and
 * exit badge. Mounts one REAL `ContentPanel` per state, so the chip and the
 * badge are judged in the header row they ship in.
 *
 * Query parameters (the capture spec drives these):
 *   ?theme=<built-in theme id>
 *   ?rm=1   turn on the app's reduce-animations flag
 *
 * `window.__setAgentState(rowId, state)` flips a live row's state, so the
 * spec can photograph the chip mid-transition.
 *
 * An exited pane's header unmounts the chip (`getTerminalAgentDisplayState`
 * resolves to nothing once the pane has exited), so the tooltip's exit line is
 * photographed from the real indicator mounted on its own.
 */

interface Row {
  id: string;
  label: string;
  agent: "claude" | null;
  agentState?: AgentState;
  isExited?: boolean;
  exitCode?: number | null;
  sessionCost?: number;
}

const ROWS: Row[] = [
  { id: "working", label: "Working", agent: "claude", agentState: "working" },
  { id: "waiting", label: "Waiting", agent: "claude", agentState: "waiting" },
  { id: "directing", label: "Directing", agent: "claude", agentState: "directing" },
  {
    id: "agent-exit-0",
    label: "Agent exited 0",
    agent: "claude",
    agentState: "exited",
    isExited: true,
    exitCode: 0,
    sessionCost: 0.42,
  },
  {
    id: "agent-exit-1",
    label: "Agent exited 1",
    agent: "claude",
    agentState: "exited",
    isExited: true,
    exitCode: 1,
    sessionCost: 0.42,
  },
  {
    id: "agent-exit-signal",
    label: "Agent killed",
    agent: "claude",
    agentState: "exited",
    isExited: true,
    exitCode: null,
    sessionCost: 0.42,
  },
  { id: "shell-exit-0", label: "Shell exited 0", agent: null, isExited: true, exitCode: 0 },
  { id: "shell-exit-130", label: "Shell exited 130", agent: null, isExited: true, exitCode: 130 },
  { id: "shell-exit-signal", label: "Shell killed", agent: null, isExited: true, exitCode: null },
];

const TOOLTIP_ROWS = [
  { id: "tip-exit-0", exitCode: 0 },
  { id: "tip-exit-1", exitCode: 1 },
  { id: "tip-exit-signal", exitCode: null },
] as const;

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const reduceMotion = params.get("rm") === "1";
const noop = () => {};
const now = Date.now();

usePanelStore.setState({
  panelsById: Object.fromEntries([
    ...TOOLTIP_ROWS.map((row) => [
      row.id,
      {
        id: row.id,
        kind: "terminal",
        title: "Claude",
        location: "grid",
        cwd: "/Users/dev/acme-platform",
        cols: 120,
        rows: 40,
        launchAgentId: "claude",
        detectedAgentId: "claude",
        agentState: "exited",
        stateChangeTrigger: "exit",
        lastStateChange: now - 65_000,
        startedAt: now - 600_000,
        sessionCost: 0.42,
        sessionTokens: 184_000,
      } as PtyPanelData,
    ]),
    ...ROWS.map((row) => [
      row.id,
      {
        id: row.id,
        kind: "terminal",
        title: row.agent ? "Claude" : "zsh",
        location: "grid",
        cwd: "/Users/dev/acme-platform",
        cols: 120,
        rows: 40,
        ...(row.agent ? { launchAgentId: row.agent, detectedAgentId: row.agent } : {}),
        agentState: row.agentState,
        lastStateChange: now - 65_000,
        startedAt: now - 600_000,
        sessionCost: row.sessionCost,
        sessionTokens: row.sessionCost != null ? 184_000 : undefined,
      } as PtyPanelData,
    ]),
  ]),
  panelIds: ROWS.map((row) => row.id),
} as Partial<ReturnType<typeof usePanelStore.getState>>);
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

function PreviewRow({ row }: { row: Row }) {
  const [agentState, setAgentState] = useState(row.agentState);

  useEffect(() => {
    const setters = (Reflect.get(window, "__agentStateSetters") ?? {}) as Record<
      string,
      (s: AgentState) => void
    >;
    setters[row.id] = (next) => {
      usePanelStore.setState((s) => ({
        panelsById: {
          ...s.panelsById,
          [row.id]: { ...s.panelsById[row.id], agentState: next } as PtyPanelData,
        },
      }));
      setAgentState(next);
    };
    Reflect.set(window, "__agentStateSetters", setters);
  }, [row.id]);

  return (
    <div data-shot={row.id} className="flex flex-col gap-1">
      <div className="text-2xs text-text-muted font-mono">{row.label}</div>
      <div style={{ width: 560, height: 64 }}>
        <ContentPanel
          id={row.id}
          title={row.agent ? "Claude" : "zsh"}
          kind="terminal"
          isFocused={false}
          location="grid"
          isMultiPanelGrid
          onFocus={noop}
          onClose={noop}
          onToggleMaximize={noop}
          onTitleChange={noop}
          onMinimize={noop}
          onRestart={noop}
          agentId={row.agent ?? undefined}
          detectedAgentId={row.agent ?? undefined}
          agentState={agentState}
          isExited={row.isExited}
          exitCode={row.exitCode}
          onAddTab={noop}
        >
          <div className="flex-1" />
        </ContentPanel>
      </div>
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
    if (reduceMotion) document.body.dataset.reduceAnimations = "true";
    Reflect.set(window, "__setAgentState", (id: string, state: AgentState) => {
      const setters = Reflect.get(window, "__agentStateSetters") as Record<
        string,
        (s: AgentState) => void
      >;
      setters[id]!(state);
    });
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <div data-preview-root className="bg-surface-canvas p-4 flex flex-col gap-3 w-fit">
      {ROWS.map((row) => (
        <PreviewRow key={row.id} row={row} />
      ))}
      <div className="flex gap-6 pt-2">
        {TOOLTIP_ROWS.map((row) => (
          <div key={row.id} data-shot={row.id} className="flex items-center gap-2">
            <span className="text-2xs text-text-muted font-mono">{row.id}</span>
            <TerminalAgentIndicator
              id={row.id}
              agentState="exited"
              isExited
              exitCode={row.exitCode}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
