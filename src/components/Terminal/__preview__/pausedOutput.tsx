import "./pausedOutputShims";
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
import {
  FIXTURES,
  FIXTURE_NAMES,
  type FixtureName,
  type PausedOutputFixture,
} from "./pausedOutputFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the pane header's status slot tooltip —
 * held output, a slow submit, and both at once.
 *
 * A backpressure hold lasts as long as the pane takes to drain, so nobody sees
 * it on purpose. This mounts the real `ContentPanel` per fixture with the flow
 * and submit status passed the way `TerminalPane` passes them, and seeds the
 * held-duration gauge into the real panel store the tooltip reads.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

const PANE_WIDTH = 460;
const PANE_HEIGHT = 168;
const TITLE = "Claude";
const TASK = "fix flaky auth tests";
const noop = () => {};

function paneId(name: FixtureName): string {
  return `pane-${name}`;
}

function seedStores(): void {
  const rows: Record<string, PtyPanelData> = {};
  for (const name of FIXTURE_NAMES) {
    const f: PausedOutputFixture = FIXTURES[name];
    const id = paneId(name);
    rows[id] = {
      id,
      kind: "terminal",
      title: TITLE,
      lastObservedTitle: TASK,
      location: "grid",
      cwd: "/Users/dev/acme-platform",
      cols: 120,
      rows: 40,
      detectedAgentId: "claude",
      launchAgentId: "claude",
      agentState: "working",
      lastStateChange: Date.now() - 65_000,
      startedAt: Date.now() - 600_000,
      flowStatus: f.flowStatus,
      heldDurationMs: f.heldDurationMs,
    } satisfies PtyPanelData;
  }
  usePanelStore.setState({
    panelsById: rows,
    panelIds: Object.keys(rows),
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
}

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div>$ npm test -- src/auth</div>
      <div className="text-text-muted">✓ refresh token rotates on expiry (41 ms)</div>
      <div className="text-text-muted">✓ session survives a clock skew of 30s (12 ms)</div>
      <div className="text-text-muted">✓ revoked token is rejected (8 ms)</div>
    </div>
  );
}

function Pane({ name }: { name: FixtureName }) {
  const f: PausedOutputFixture = FIXTURES[name];
  return (
    <div
      data-preview-pane={name}
      className="bg-surface-canvas p-2"
      style={{ width: PANE_WIDTH, height: PANE_HEIGHT + 16 }}
    >
      <ContentPanel
        id={paneId(name)}
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
        agentId="claude"
        detectedAgentId="claude"
        agentState="working"
        flowStatus={f.flowStatus}
        submitStatus={f.submitStatus}
        onAddTab={noop}
      >
        <TerminalLines />
      </ContentPanel>
    </div>
  );
}

function App() {
  const [themed, setThemed] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setThemed(true);
  }, [scheme]);

  if (!themed) return null;

  return (
    <div
      data-preview-shell
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}
    >
      {FIXTURE_NAMES.map((name) => (
        <div key={name} data-shot={name} style={{ width: "max-content" }}>
          <div
            style={{
              padding: "2px 10px",
              fontSize: "var(--text-2xs)",
              fontFamily: "ui-monospace, monospace",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--color-text-muted)",
            }}
          >
            {name}
          </div>
          <Pane name={name} />
        </div>
      ))}
    </div>
  );
}

seedStores();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
