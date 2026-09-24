import "./scrollPillShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import type { TerminalResourceBatchPayload } from "@shared/types/pty-host";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import {
  FIXTURES,
  FIXTURE_NAMES,
  type FixtureName,
  type ResourceBadgeFixture,
} from "./resourceBadgeFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the pane header's resource badge — the
 * CPU sparkline and the "12% · 180M" readout at the telemetry end of the row.
 *
 * The badge only exists with monitoring enabled and a PTY that has been sampled
 * at least twice, and its colour is decided by a hysteresis that needs several
 * consecutive polls over a threshold. So this mounts the real `ContentPanel` for
 * each fixture and replays the fixture's samples through the real
 * `resourceMonitoringStore.updateMetrics`, one batch per tick — the same seam the
 * pty-host's `resource-metrics` event drives. Nothing in the header is a copy.
 *
 * Stand-ins: the pane body is a few quiet terminal lines.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

const DEFAULT_WIDTH = 560;
const PANE_HEIGHT = 96;
const noop = () => {};
/** Long enough for the header's effect to run between two store batches. */
const REPLAY_TICK_MS = 24;

function paneId(name: FixtureName): string {
  return `pane-${name}`;
}

function samplesOf(fixture: ResourceBadgeFixture, i: number) {
  const memory = Array.isArray(fixture.memoryKb)
    ? (fixture.memoryKb[i] ?? fixture.memoryKb[fixture.memoryKb.length - 1]!)
    : fixture.memoryKb;
  // The final poll reports what its breakdown adds up to, as the pty-host's
  // own sum would, so the tooltip's rows and headline agree.
  const isLast = i === fixture.cpu.length - 1;
  const sum = fixture.breakdown?.reduce((total, p) => total + p.cpuPercent, 0);
  return {
    cpuPercent: isLast && sum !== undefined && !fixture.processCount ? sum : fixture.cpu[i]!,
    memoryKb: memory,
    breakdown: fixture.breakdown ?? [],
    processCount: fixture.processCount ?? fixture.breakdown?.length,
  };
}

/** "Identity: task" is what a reader expects; the store holds the two halves apart. */
function splitTitle(title: string): { identity: string; task?: string } {
  const at = title.indexOf(": ");
  if (at < 0) return { identity: title };
  return { identity: title.slice(0, at), task: title.slice(at + 2) };
}

function seedStores(): void {
  const rows: Record<string, PtyPanelData> = {};
  for (const name of FIXTURE_NAMES) {
    const f: ResourceBadgeFixture = FIXTURES[name];
    const id = paneId(name);
    const { identity, task } = splitTitle(f.title);
    rows[id] = {
      id,
      kind: "terminal",
      title: identity,
      lastObservedTitle: task,
      location: "grid",
      cwd: "/Users/dev/acme-platform",
      cols: 120,
      rows: 40,
      detectedAgentId: f.agentId,
      launchAgentId: f.agentId,
      agentState: f.agentState,
      lastStateChange: Date.now() - 65_000,
      startedAt: Date.now() - 600_000,
      sessionCost: f.sessionCost,
      sessionTokens: f.sessionTokens,
      isInputLocked: f.isInputLocked,
    } satisfies PtyPanelData;
  }
  usePanelStore.setState({
    panelsById: rows,
    panelIds: Object.keys(rows),
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  useResourceMonitoringStore.setState({ enabled: true, metrics: new Map() });
}

/**
 * Replay every fixture's samples in lockstep, one store batch per tick. A tick is
 * long enough for the header's effect to run between batches, which is what lets
 * the hysteresis count polls the way it does against the real 2.5s cadence.
 */
let replaying: Promise<void> | null = null;
function replayOnce(): Promise<void> {
  // StrictMode mounts the effect twice; two interleaved replays would double
  // every history.
  replaying ??= replay();
  return replaying;
}

async function replay(): Promise<void> {
  const longest = Math.max(...FIXTURE_NAMES.map((n) => FIXTURES[n].cpu.length));
  for (let i = 0; i < longest; i++) {
    const batch: TerminalResourceBatchPayload = {};
    for (const name of FIXTURE_NAMES) {
      const f: ResourceBadgeFixture = FIXTURES[name];
      // Right-align the histories so every fixture's last sample lands on the
      // final tick — a short history is a pane that started recently.
      const offset = longest - f.cpu.length;
      if (i >= offset) batch[paneId(name)] = samplesOf(f, i - offset);
    }
    useResourceMonitoringStore.getState().updateMetrics(batch);
    await new Promise((resolve) => setTimeout(resolve, REPLAY_TICK_MS));
  }
}

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div>$ npm test -- src/auth</div>
      <div className="text-text-muted">✓ refresh token rotates on expiry (41 ms)</div>
    </div>
  );
}

function Pane({ name }: { name: FixtureName }) {
  const f: ResourceBadgeFixture = FIXTURES[name];
  const id = paneId(name);
  const { identity } = splitTitle(f.title);
  return (
    <div
      data-preview-pane={name}
      className="bg-surface-canvas p-2"
      style={{ width: f.width ?? DEFAULT_WIDTH, height: PANE_HEIGHT + 16 }}
    >
      <ContentPanel
        id={id}
        title={identity}
        kind="terminal"
        isFocused={f.isFocused ?? false}
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        onRestart={noop}
        agentId={f.agentId}
        detectedAgentId={f.agentId}
        agentState={f.agentState}
        queueCount={f.queueCount}
        onAddTab={noop}
      >
        <TerminalLines />
      </ContentPanel>
    </div>
  );
}

function App() {
  const [themed, setThemed] = useState(false);
  const [replayed, setReplayed] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setThemed(true);
  }, [scheme]);

  useEffect(() => {
    if (!themed) return;
    let cancelled = false;
    void replayOnce().then(() => {
      if (!cancelled) setReplayed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [themed]);

  if (!themed) return null;

  return (
    <div
      data-preview-shell
      data-replayed={replayed ? "true" : "false"}
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
