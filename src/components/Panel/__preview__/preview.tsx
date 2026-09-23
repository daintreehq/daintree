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
import {
  GRID_SCENES,
  isGridSceneName,
  type GridBody,
  type GridPane,
  type GridScene,
  type GridSceneName,
} from "./gridScenes";
import { GRID_GAP_PX } from "@/lib/terminalLayout";
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
 *   ?scene=mixed-agents        a whole grid of panes instead (see gridScenes.ts)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const single: FixtureName | null = isFixtureName(fixtureParam) ? fixtureParam : null;
const sceneParam = params.get("scene") ?? "";
const scene: GridSceneName | null = isGridSceneName(sceneParam) ? sceneParam : null;

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
    worktreeId: id,
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
/**
 * The app stores an agent pane's identity as `title` and the agent's reported
 * task as `lastObservedTitle`; the header composes "Identity: task" from the
 * two (and just the task when it is narrow). A fixture names the composed form
 * because that is what a reader expects to see; this splits it back into the
 * two fields the store actually holds.
 */
function splitTitle(title: string): { identity: string; task?: string } {
  const at = title.indexOf(": ");
  if (at < 0) return { identity: title };
  return { identity: title.slice(0, at), task: title.slice(at + 2) };
}

function paneRow(id: string, fixture: SeedablePane): PtyPanelData {
  const { identity, task } = splitTitle(fixture.title);
  const row = ptyRow(id, {
    title: identity,
    lastObservedTitle: task,
    // The composer only treats the observed title as a task once the agent
    // has been detected on the PTY, as it would be in the app.
    detectedAgentId: fixture.agentId,
    launchAgentId: fixture.agentId,
    agentState: fixture.agentState,
    lastStateChange: Date.now() - 65_000,
    startedAt: Date.now() - 600_000,
    worktreeId: fixture.branch ? WORKTREE_ID : undefined,
    ...fixture.panel,
  });
  // A grid scene seeds non-PTY kinds too; the row's kind is what the header's
  // Duplicate and dock checks read.
  return Object.assign(row, { kind: fixture.kind });
}

type SeedablePane = Omit<PanelHeaderFixture, "what" | "body">;

function seedGlobalStores(
  panes: Array<{ id: string; fixture: SeedablePane }>,
  background: PanelHeaderFixture["background"] = []
): void {
  const rows: Record<string, PtyPanelData> = {};
  for (const { id, fixture } of panes) rows[id] = paneRow(id, fixture);
  background.forEach((bg, index) => {
    const id = `background-${index + 1}`;
    rows[id] = ptyRow(id, { launchAgentId: "claude", agentState: bg.agentState });
  });
  const ids = (pick: (f: SeedablePane) => boolean | undefined) =>
    new Set(panes.filter(({ fixture }) => pick(fixture)).map(({ id }) => id));

  usePanelStore.setState({
    panelsById: rows,
    panelIds: Object.keys(rows),
    watchedPanels: ids((f) => f.watched),
  } as Partial<ReturnType<typeof usePanelStore.getState>>);

  // The pane's context menu pulls plugin items over IPC on mount; the shimmed bridge
  // resolves `undefined` where the real one resolves an array, and the store keeps
  // whatever it is given. Pre-empt the pull with an empty list.
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  for (const { fixture } of panes) {
    if (fixture.prefs) usePreferencesStore.setState(fixture.prefs);
  }

  useFleetArmingStore.setState({
    armedIds: ids((f) => f.armed),
    previewArmedIds: ids((f) => f.previewed),
  });
  const failed = [...ids((f) => f.fleetFailed)];
  if (failed.length > 0) {
    useFleetFailureStore.getState().recordFailure("git status", failed);
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
  fixture: { branch?: string };
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
        <span className="text-text-secondary">●</span> Reading src/auth/session.ts…
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
          title={splitTitle(fixture.title).identity}
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

const MONO = "flex-1 min-h-0 overflow-hidden px-3 py-2 font-mono text-xs leading-5 select-none";

/** Stand-in bodies for grid panes: enough texture that a pane reads as its kind. */
function GridBodyStandIn({ body }: { body: GridBody }) {
  switch (body) {
    case "agent-working":
      return (
        <div className={`${MONO} text-text-secondary`} aria-hidden="true">
          <div className="text-text-primary">● Bash(npm test -- src/auth)</div>
          <div className="text-text-muted"> ⎿ 42 passed, 1 failed (3.1s)</div>
          <div>&nbsp;</div>
          <div className="text-text-primary">● Reading src/auth/session.ts…</div>
          <div className="text-text-muted"> ⎿ 218 lines</div>
          <div>&nbsp;</div>
          <div>· Thinking… (41s · ↓ 2.8k tokens)</div>
        </div>
      );
    case "agent-idle":
      return (
        <div className={`${MONO} text-text-secondary`} aria-hidden="true">
          <div className="text-text-primary">Welcome back</div>
          <div className="text-text-muted">~/Projects/acme-platform</div>
          <div>&nbsp;</div>
          <div className="border-y border-divider py-1">› Try &quot;edit plugin.ts to…&quot;</div>
        </div>
      );
    case "shell":
      return (
        <div className={`${MONO} text-text-secondary`} aria-hidden="true">
          <div>$ npm run dev</div>
          <div className="text-text-muted"> VITE v8.0.14 ready in 412 ms</div>
          <div className="text-text-muted"> ➜ Local: http://localhost:5173/</div>
        </div>
      );
    case "file-tree":
      return (
        <div
          className="flex-1 min-h-0 overflow-hidden px-2 py-1.5 text-xs leading-6 text-text-secondary select-none"
          aria-hidden="true"
        >
          {[
            "▾ src",
            "   ▾ auth",
            "      session.ts",
            "      tokens.ts",
            "   ▸ billing",
            "   ▸ ui",
            "▸ tests",
            "  package.json",
          ].map((line) => (
            <div key={line} className="whitespace-pre">
              {line}
            </div>
          ))}
        </div>
      );
    case "code":
      return (
        <div className={`${MONO} text-text-secondary`} aria-hidden="true">
          <div>
            <span className="text-text-muted">1 </span>import {"{"} rotate {"}"} from
            &quot;./tokens&quot;;
          </div>
          <div>
            <span className="text-text-muted">2 </span>&nbsp;
          </div>
          <div>
            <span className="text-text-muted">3 </span>export async function refresh(s: Session){" "}
            {"{"}
          </div>
          <div>
            <span className="text-text-muted">4 </span> if (s.expiresAt &gt; Date.now()) return s;
          </div>
          <div>
            <span className="text-text-muted">5 </span> return rotate(s);
          </div>
          <div>
            <span className="text-text-muted">6 </span>
            {"}"}
          </div>
        </div>
      );
    case "diff":
      return (
        <div className={`${MONO} text-text-secondary`} aria-hidden="true">
          <div className="text-text-muted">@@ -12,6 +12,9 @@</div>
          <div> export async function refresh(s: Session) {"{"}</div>
          <div className="bg-overlay-soft">- if (s.expiresAt &lt; Date.now()) return s;</div>
          <div className="bg-overlay-medium">+ if (s.expiresAt &gt; Date.now()) return s;</div>
          <div> return rotate(s);</div>
        </div>
      );
    case "browser":
      return <div className="flex-1 min-h-0 m-2 rounded-sm bg-overlay-soft" aria-hidden="true" />;
    case "review":
      return (
        <div
          className="flex-1 min-h-0 overflow-hidden px-3 py-2 text-xs leading-6 text-text-secondary select-none"
          aria-hidden="true"
        >
          <div className="text-text-primary">3 files changed</div>
          <div>
            src/auth/session.ts <span className="text-text-muted">+3 −1</span>
          </div>
          <div>
            src/auth/tokens.ts <span className="text-text-muted">+12 −4</span>
          </div>
          <div>
            tests/auth.spec.ts <span className="text-text-muted">+40</span>
          </div>
        </div>
      );
  }
}

/**
 * The row a browser, editor or diff pane draws under its header. A stand-in at the
 * real height (`h-8`, see `BrowserPaneSkeleton`) so the vertical rhythm of a
 * non-terminal pane is the real one.
 */
function KindToolbarStandIn({ label }: { label: string }) {
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-muted"
      aria-hidden="true"
    >
      <span className="h-5 flex-1 truncate rounded-sm bg-overlay-subtle px-2 leading-5">
        {label}
      </span>
    </div>
  );
}

const TOOLBAR_LABEL: Partial<Record<GridBody, string>> = {
  browser: "http://localhost:5173/login",
  code: "src/auth/session.ts",
  diff: "src/auth/session.ts",
};

function GridScenePane({ pane }: { pane: GridPane }) {
  const toolbarLabel = TOOLBAR_LABEL[pane.body];
  const hasPty = panelKindHasPty(pane.kind);
  return (
    <div data-preview-pane={pane.id} className="h-full min-w-0">
      <ContentPanel
        id={pane.id}
        title={splitTitle(pane.title).identity}
        kind={pane.kind}
        worktreeId={pane.branch ? WORKTREE_ID : undefined}
        isFocused={pane.isFocused}
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        onRestart={hasPty ? noop : undefined}
        agentId={pane.agentId}
        detectedAgentId={pane.agentId}
        agentState={pane.agentState}
        activityStatus={pane.activityStatus}
        lastCommand={pane.lastCommand}
        isExited={pane.isExited}
        exitCode={pane.exitCode}
        agentLaunchFlags={pane.agentLaunchFlags}
        queueCount={pane.queueCount}
        isSelected={pane.isSelected}
        isFleetFollower={pane.isFleetFollower}
        onAddTab={hasPty ? noop : undefined}
        toolbar={toolbarLabel ? <KindToolbarStandIn label={toolbarLabel} /> : undefined}
      >
        <GridBodyStandIn body={pane.body} />
      </ContentPanel>
    </div>
  );
}

/**
 * The grid container, drawn the way `ContentGridDefault` draws it: the noise
 * canvas, the grid background token, the gutter and the edge padding. The gutter
 * comes from the same constant the grid reads, so a change there shows up here.
 */
function GridSceneView({ name }: { name: GridSceneName }) {
  const def: GridScene = GRID_SCENES[name];
  const branch = def.panes.find((p: GridPane) => p.branch)?.branch;
  return (
    <SeedWorktrees fixture={{ branch }}>
      <div
        data-preview-grid={name}
        className="bg-noise p-1"
        style={{
          width: def.width,
          height: def.height,
          display: "grid",
          gridTemplateColumns: `repeat(${def.cols}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(0, 1fr)",
          gap: `${GRID_GAP_PX}px`,
          backgroundColor: "var(--color-grid-bg)",
        }}
      >
        {def.panes.map((pane: GridPane) => (
          <GridScenePane key={pane.id} pane={pane} />
        ))}
      </div>
    </SeedWorktrees>
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

  if (scene) {
    return <GridSceneView name={scene} />;
  }

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
        const fixture: PanelHeaderFixture = FIXTURES[name];
        const wide = (fixture.width ?? DEFAULT_WIDTH) > DEFAULT_WIDTH;
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
if (scene) {
  seedGlobalStores(
    GRID_SCENES[scene].panes.map((pane: GridPane) => ({ id: pane.id, fixture: pane }))
  );
} else {
  const fixture: PanelHeaderFixture = FIXTURES[single ?? FIXTURE_NAMES[0]!];
  seedGlobalStores([{ id: PANE_ID, fixture }], fixture.background);
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
