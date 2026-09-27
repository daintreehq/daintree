import "./subagentChipShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { FIXTURES, isFixtureName, type SubagentChipFixture } from "./subagentChipFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the terminal header's subagent chip.
 *
 * Mounts the real `ContentPanel` for an agent pane, so the chip is judged in
 * the header row it ships in, beside its real neighbours. The chip's hook and
 * rows read through `window.electron.codex` / `.claude`, which the shim answers
 * from the fixture — the same seam the app uses, not a mock of the component.
 *
 * Query parameters (the capture spec drives these):
 *   ?theme=<built-in theme id>
 *   ?fixture=<name>   one of FIXTURES in subagentChipFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "codex-mixed";
if (!isFixtureName(fixtureParam)) throw new Error(`unknown fixture "${fixtureParam}"`);
const fixture: SubagentChipFixture = FIXTURES[fixtureParam];

const PANE_ID = "pane-under-review";
const PANE_HEIGHT = 420;
const noop = () => {};

const TITLE = fixture.provider === "codex" ? "Codex" : "Claude";
const TASK = "Harden the session refresh path";

usePanelStore.setState({
  panelsById: {
    [PANE_ID]: {
      id: PANE_ID,
      kind: "terminal",
      title: TITLE,
      lastObservedTitle: TASK,
      location: "grid",
      cwd: "/Users/dev/acme-platform",
      cols: 120,
      rows: 40,
      launchAgentId: fixture.provider,
      detectedAgentId: fixture.provider,
      agentState: "working",
      lastStateChange: Date.now() - 65_000,
      startedAt: Date.now() - 600_000,
    } as PtyPanelData,
  },
  panelIds: [PANE_ID],
} as Partial<ReturnType<typeof usePanelStore.getState>>);
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div className="text-text-primary">• Spawned 5 subagents to split the review</div>
      <div className="text-text-muted"> └ Meitner, Kant, Hopper, Noether, +1</div>
      <div>&nbsp;</div>
      <div>• Waiting on reviewer results…</div>
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

  return (
    <div
      data-preview-pane
      className="bg-surface-canvas p-2"
      style={{ width: fixture.width, height: PANE_HEIGHT }}
    >
      <ContentPanel
        id={PANE_ID}
        title={TITLE}
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
        agentId={fixture.provider}
        detectedAgentId={fixture.provider}
        agentState="working"
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
