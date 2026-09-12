import "./installShims";
import { StrictMode, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { WorktreeSnapshot } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { ContentPanel } from "../ContentPanel";
import { PluginMissingPanel } from "../PluginMissingPanel";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { TabInfo } from "../TabButton";
import {
  FIXTURES,
  FIXTURE_NAMES,
  OTHER_WORKTREE_ID,
  PANE_ID,
  WORKTREE_ID,
  isFixtureName,
  type FixtureName,
  type PanelHeaderFixture,
} from "./fixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the panel header.
 *
 * The header renders on every pane in the app, and its states are mostly things the
 * grid decides for it — focused, part of an armed fleet, a follower, previewed from
 * the fleet menu, maximized over three busy background panes, docked. Reaching each
 * one in the real app means arranging a whole workspace around it, and the ones that
 * matter most (a follower next to the primary, a broadcast that failed on one pane)
 * need a second agent to be doing something at the same time.
 *
 * So this mounts the real `ContentPanel` — the pane frame that hosts the header,
 * resolves its metadata / status / agent-glyph slots and paints `terminal-selected`
 * and `panel-state-*` on the frame — against the real theme tokens and the real
 * `index.css`, with the four stores it reads seeded from a fixture that names the
 * state. Nothing under the pane frame is a copy.
 *
 * What is a stand-in: the pane body (terminal lines, a browser block, or the real
 * `PluginMissingPanel`) and the grid around it. Both are here only so the header has
 * its real neighbours.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?fixture=follower          one state, alone — omit for the contact sheet of all of them
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const single: FixtureName | null = isFixtureName(fixtureParam) ? fixtureParam : null;

const DEFAULT_WIDTH = 560;
const PANE_HEIGHT = 150;

const noop = () => {};

function toTabInfo(tabs: NonNullable<PanelHeaderFixture["tabs"]>): TabInfo[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    kind: tab.kind,
    agentState: tab.agentState,
    isActive: tab.isActive ?? false,
    hasDangerousFlags: tab.hasDangerousFlags,
    chrome: deriveTerminalChrome({
      kind: tab.kind,
      launchAgentId: tab.agentId,
      detectedAgentId: tab.agentId,
      agentState: tab.agentState,
    }),
  }));
}

function ptyRow(id: string, extra: Partial<PtyPanelData>): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/Users/dev/acme-platform",
    cols: 120,
    rows: 40,
    ...extra,
  } as PtyPanelData;
}

function worktree(id: string, branch: string, extra: Partial<WorktreeSnapshot>): WorktreeSnapshot {
  return {
    id,
    path: `/Users/dev/acme-platform-worktrees/${branch.replace(/\//g, "-")}`,
    name: branch,
    branch,
    isCurrent: false,
    ...extra,
  };
}

/**
 * Put the fixture's rows into the app-global stores. Runs once per page, before the
 * pane mounts — every store here is a module singleton, so a single fixture per page
 * is the only way two states cannot leak into each other.
 */
function seedGlobalStores(fixture: PanelHeaderFixture): void {
  const rows: Record<string, PtyPanelData> = {
    [PANE_ID]: ptyRow(PANE_ID, {
      title: fixture.title,
      launchAgentId: fixture.agentId as PtyPanelData["launchAgentId"],
      agentState: fixture.agentState,
      lastStateChange: Date.now() - 65_000,
      startedAt: Date.now() - 600_000,
      worktreeId: fixture.branch ? WORKTREE_ID : undefined,
      ...fixture.panel,
    }),
  };
  (fixture.background ?? []).forEach((bg, index) => {
    const id = `background-${index + 1}`;
    rows[id] = ptyRow(id, { launchAgentId: "claude", agentState: bg.agentState });
  });
  usePanelStore.setState({
    panelsById: rows,
    panelIds: Object.keys(rows),
    watchedPanels: new Set(fixture.watched ? [PANE_ID] : []),
  } as Partial<ReturnType<typeof usePanelStore.getState>>);

  // The pane's context menu pulls plugin items over IPC on mount; the shimmed bridge
  // resolves `undefined` where the real one resolves an array, and the store keeps
  // whatever it is given. Pre-empt the pull with an empty list.
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  if (fixture.prefs) usePreferencesStore.setState(fixture.prefs);

  useFleetArmingStore.setState({
    armedIds: new Set(fixture.armed ? [PANE_ID] : []),
    previewArmedIds: new Set(fixture.previewed ? [PANE_ID] : []),
  });
  if (fixture.fleetFailed) {
    useFleetFailureStore.getState().recordFailure("git status", [PANE_ID]);
  }
}

/**
 * The per-view worktree store is created by the provider, so it is seeded from
 * inside the tree. Two worktrees are what make the branch badge appear at all — a
 * single-worktree project suppresses the colour map on purpose.
 */
function SeedWorktrees({
  fixture,
  children,
}: {
  fixture: PanelHeaderFixture;
  children: ReactNode;
}) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    if (store && fixture.branch) {
      store.setState({
        worktrees: new Map<string, WorktreeSnapshot>([
          [OTHER_WORKTREE_ID, worktree(OTHER_WORKTREE_ID, "main", { isMainWorktree: true })],
          [WORKTREE_ID, worktree(WORKTREE_ID, fixture.branch, {})],
        ]),
      });
    }
    return true;
  });
  return ready ? children : null;
}

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div>$ npm test -- src/auth</div>
      <div className="text-text-muted">✓ refresh token rotates on expiry (41 ms)</div>
      <div className="text-text-muted">✓ rejects a replayed nonce (12 ms)</div>
      <div>
        <span className="text-status-success">●</span> Reading src/auth/session.ts…
      </div>
    </div>
  );
}

function BrowserBlock() {
  return <div className="flex-1 min-h-0 m-2 rounded-sm bg-overlay-soft" aria-hidden="true" />;
}

function Body({ fixture }: { fixture: PanelHeaderFixture }) {
  if (fixture.body === "plugin-missing") {
    return <PluginMissingPanel kind="daintree.github.prs" onRemove={noop} />;
  }
  if (fixture.body === "browser") return <BrowserBlock />;
  return <TerminalLines />;
}

function Pane({ name }: { name: FixtureName }) {
  const fixture: PanelHeaderFixture = FIXTURES[name];
  const location = fixture.location ?? "grid";
  const isDock = location === "dock";
  const width = fixture.width ?? DEFAULT_WIDTH;

  return (
    <div
      data-preview-pane={name}
      className={fixture.isMaximized || isDock ? "bg-surface-canvas" : "bg-surface-canvas p-2"}
      style={{ width, height: PANE_HEIGHT + (fixture.isMaximized || isDock ? 0 : 16) }}
    >
      <SeedWorktrees fixture={fixture}>
        <ContentPanel
          id={PANE_ID}
          title={fixture.title}
          kind={fixture.kind}
          worktreeId={fixture.branch ? WORKTREE_ID : undefined}
          isFocused={fixture.isFocused}
          isMaximized={fixture.isMaximized}
          location={location}
          isMultiPanelGrid
          onFocus={noop}
          onClose={noop}
          onToggleMaximize={isDock ? undefined : noop}
          onTitleChange={noop}
          onMinimize={noop}
          onRestore={isDock ? noop : undefined}
          showRestoreControl={isDock}
          onRestart={panelKindHasPty(fixture.kind) ? noop : undefined}
          agentId={fixture.agentId}
          detectedAgentId={fixture.agentId}
          agentState={fixture.agentState}
          activityStatus={fixture.activityStatus}
          lastCommand={fixture.lastCommand}
          isExited={fixture.isExited}
          exitCode={fixture.exitCode}
          agentLaunchFlags={fixture.agentLaunchFlags}
          queueCount={fixture.queueCount}
          flowStatus={fixture.flowStatus}
          completedWithNoChanges={fixture.completedWithNoChanges}
          isSelected={fixture.isSelected}
          isFleetFollower={fixture.isFleetFollower}
          isHibernated={fixture.isHibernated}
          tabs={fixture.tabs ? toTabInfo(fixture.tabs) : undefined}
          groupId={fixture.tabs ? "group-under-review" : undefined}
          onTabClick={fixture.tabs ? noop : undefined}
          onTabClose={fixture.tabs ? noop : undefined}
          onTabRename={fixture.tabs ? noop : undefined}
          onTabReorder={fixture.tabs ? noop : undefined}
          onAddTab={panelKindHasPty(fixture.kind) ? noop : undefined}
        >
          <Body fixture={fixture} />
        </ContentPanel>
      </SeedWorktrees>
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

  if (single) {
    return <Pane name={single} />;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(2, ${DEFAULT_WIDTH}px)`,
        gap: "16px",
        padding: "16px",
        alignItems: "start",
      }}
    >
      {FIXTURE_NAMES.map((name) => {
        const wide = (FIXTURES[name].width ?? DEFAULT_WIDTH) > DEFAULT_WIDTH;
        return (
          <div
            key={name}
            style={{
              gridColumn: wide ? "span 2" : undefined,
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
              width: "max-content",
            }}
          >
            <div
              style={{
                padding: "6px 10px",
                fontSize: "var(--text-2xs)",
                fontFamily: "ui-monospace, monospace",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
                background: "var(--color-surface-toolbar)",
                borderBottom: "1px solid var(--color-border-divider)",
              }}
            >
              {name}
            </div>
            <Pane name={name} />
          </div>
        );
      })}
    </div>
  );
}

// The stores are module singletons, so the contact sheet can only seed ONE fixture's
// rows — it seeds the first and the rest render against it. That is fine for a theme
// sweep, whose question is "does the palette hold", and wrong for anything that
// depends on store state, which is why every state that does is captured alone.
seedGlobalStores(FIXTURES[single ?? FIXTURE_NAMES[0]!]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
