import { PREVIEW_PROJECT } from "./toolbarShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import {
  WINDOWS_CAPTION_WIDTH_PX,
  WINDOWS_CAPTION_SYMBOL_COLOR,
} from "@shared/config/windowChrome";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { Toolbar } from "../Toolbar";
import "@/index.css";

/**
 * Standalone visual-review harness for the main toolbar's two button runs.
 *
 * Mounts the REAL `Toolbar` against seeded stores and the real theme tokens, at
 * a real window width, with the native window controls painted where the OS
 * puts them: the macOS traffic lights at `trafficLightPosition` (12, 18), and
 * the Windows 11 caption cluster in the 138px strip `WINDOWS_CAPTION_WIDTH_PX`
 * reserves. Those controls are drawn by the OS, not the page, so a capture of
 * the page alone can never show how the strip balances against them.
 *
 * The Electron harness (`toolbar-strip-review.spec.ts`) needs a fake binary per
 * agent to pin four of them; the states that carry the design questions here —
 * four pinned agents, one of them with presets and a live pip — are store
 * values, so they are seeded directly.
 *
 * Query parameters:
 *   ?theme=<id>              built-in theme id (default daintree)
 *   ?fixture=<name>          one of FIXTURES below (default owner)
 *   ?platform=mac|windows    which native controls to paint (default mac)
 *   ?fullscreen=1            macOS fullscreen: no traffic lights, no spacer
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "owner";
const platform = params.get("platform") === "windows" ? "windows" : "mac";

const PROJECT = PREVIEW_PROJECT;

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
];

const OWNER_PINS: readonly BuiltInAgentId[] = ["claude", "antigravity", "codex", "grok"];
const OTHERS: readonly BuiltInAgentId[] = ["opencode", "gemini", "cursor", "goose", "kimi"];

interface Fixture {
  pinned: readonly BuiltInAgentId[];
  /** Agents given shared presets, which is what gives a button its preset menu. */
  presets: readonly BuiltInAgentId[];
  /** Agents with a live session waiting on the user — the amber pip. */
  waiting: readonly BuiltInAgentId[];
  leftExtras: readonly AnyToolbarButtonId[];
  unread: number;
}

const FIXTURES: Record<string, Fixture> = {
  /** The owner's own toolbar: four pinned agents, Claude with presets and waiting. */
  owner: {
    pinned: OWNER_PINS,
    presets: ["claude"],
    waiting: ["claude"],
    leftExtras: ["dev-server"],
    unread: 3,
  },
  /** The same toolbar with no presets anywhere — the baseline an agent button starts from. */
  "owner-no-presets": {
    pinned: OWNER_PINS,
    presets: [],
    waiting: ["claude"],
    leftExtras: ["dev-server"],
    unread: 3,
  },
  /** Two agents with presets side by side, so a run of preset buttons can be judged. */
  "multi-presets": {
    pinned: OWNER_PINS,
    presets: ["claude", "codex"],
    waiting: [],
    leftExtras: ["dev-server"],
    unread: 0,
  },
  /** Presets on an agent that is not first in the run — the seam then sits mid-row. */
  "presets-mid": {
    pinned: OWNER_PINS,
    presets: ["antigravity"],
    waiting: ["codex"],
    leftExtras: ["dev-server"],
    unread: 0,
  },
  /** A fresh profile: no pinned agents, the default panel buttons. */
  fresh: {
    pinned: [],
    presets: [],
    waiting: [],
    leftExtras: [],
    unread: 0,
  },
};

const fixture = FIXTURES[fixtureName] ?? FIXTURES.owner!;

function agentPanel(id: string, agentId: BuiltInAgentId): PtyPanelData {
  const panel: PtyPanelData = {
    id,
    title: agentId,
    kind: "terminal",
    cwd: PROJECT.path,
    cols: 120,
    rows: 40,
    worktreeId: "wt-main",
    location: "grid",
    hasPty: true,
    detectedAgentId: agentId,
    launchAgentId: agentId,
    agentState: "waiting",
    runtimeStatus: "running",
  };
  return panel;
}

let worktreeStore = createWorktreeStore();
let agentAvailability: CliAvailability = {};
let agentSettings: AgentSettings = { agents: {} };

/**
 * Seeded before the first render, never from inside a component body — React
 * flags a store write during another component's render as a cross-component
 * update, and the toolbar reads every one of these on mount.
 */
function seedStores(): void {
  initBuiltInPanelKinds();
  // Brand marks resolve their inks from this store, not from the tokens on the
  // root — without it every theme's marks are measured against the default dark.
  useAppThemeStore.setState({ selectedSchemeId: themeId });

  worktreeStore = createWorktreeStore();
  worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: PROJECT });

  const availability: Record<string, AgentAvailabilityState> = {};
  for (const id of [...OWNER_PINS, ...OTHERS]) availability[id] = "ready";
  agentAvailability = availability as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });

  agentSettings = {
    agents: Object.fromEntries(fixture.pinned.map((id) => [id, { pinned: true }])),
  } as AgentSettings;
  useAgentSettingsStore.setState({ settings: agentSettings });

  const layout = useToolbarPreferencesStore.getState().layout;
  useToolbarPreferencesStore.setState({
    layout: {
      ...layout,
      leftButtons: [
        "launcher",
        ...fixture.pinned,
        ...layout.leftButtons.filter((id) => id !== "launcher"),
        ...fixture.leftExtras,
      ],
    },
  });

  useProjectPresetsStore.setState({
    presetsByAgent: Object.fromEntries(
      fixture.presets.map((id) => [
        id,
        [
          { id: `${id}-plan`, name: "Plan first" },
          { id: `${id}-fast`, name: "Fast" },
        ],
      ])
    ),
  });

  const panels = fixture.waiting.map((agentId, i) => agentPanel(`pane-${i}`, agentId));
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { "wt-main": panels.map((p) => p.id) },
  });

  if (fixture.unread > 0) {
    useNotificationHistoryStore.setState({ unreadCount: fixture.unread });
  }
}

seedStores();

const noop = () => {};
/** macOS 26 traffic lights: 14px discs on a 23px pitch, top-left at (12, 18). */
function TrafficLights() {
  const colors = ["#ff5f57", "#febc2e", "#28c840"];
  return (
    <div
      aria-hidden="true"
      data-native-chrome="mac"
      className="pointer-events-none"
      // The OS draws these above the page, and the toolbar sits at z-60.
      style={{ position: "absolute", inset: 0, zIndex: 100 }}
    >
      {colors.map((color, i) => (
        <span
          key={color}
          className="rounded-full"
          style={{
            position: "absolute",
            left: 12 + i * 23,
            top: 18,
            width: 14,
            height: 14,
            background: color,
            boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.25)",
          }}
        />
      ))}
    </div>
  );
}

/** Windows 11 caption cluster: three 46px backplates across the reserved strip. */
function WindowsCaption() {
  const stroke = WINDOWS_CAPTION_SYMBOL_COLOR;
  return (
    <div
      aria-hidden="true"
      data-native-chrome="windows"
      className="pointer-events-none"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        zIndex: 100,
        width: WINDOWS_CAPTION_WIDTH_PX,
        height: 48,
        display: "flex",
      }}
    >
      {["min", "max", "close"].map((kind) => (
        <span key={kind} style={{ width: 46, height: 48, display: "grid", placeItems: "center" }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke={stroke}>
            {kind === "min" && <path d="M0 5.5h10" />}
            {kind === "max" && <rect x="0.5" y="0.5" width="9" height="9" />}
            {kind === "close" && <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />}
          </svg>
        </span>
      ))}
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  // The real hook, so the pill is wired exactly as AppLayout wires it.
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <div data-preview-window="" className="relative flex h-screen flex-col">
          <Toolbar
            onLaunchAgent={noop}
            onSettings={noop}
            hasWorkspace
            agentAvailability={agentAvailability}
            agentSettings={agentSettings}
            projectSwitcherPalette={projectSwitcherPalette}
          />
          {platform === "mac" ? <TrafficLights /> : <WindowsCaption />}
          <div className="flex flex-1">
            <div className="w-[320px] shrink-0 border-r border-divider bg-surface-sidebar" />
            <div className="flex-1 bg-surface-canvas" />
          </div>
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
