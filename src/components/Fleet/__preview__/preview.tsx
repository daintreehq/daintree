import "./bootstrap";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import motionFeatures from "@/lib/motionFeatures";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetRunStore, type FleetRunTarget } from "@/store/fleetRunStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { ProjectSettings } from "@shared/types/project";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { FleetDraftingPill } from "../FleetDraftingPill";
import { FleetPickerPalette } from "../FleetPickerPalette";
import "@/index.css";

// Dynamic rather than static so the harness entry obeys the same lazy-load rule as the
// app bundle (#7659). The ribbon's `m.div` renders pinned at its `initial` pose without a
// feature provider, so this is load-bearing, not decoration.
const { LazyMotion } = await import("framer-motion");

/**
 * Standalone visual-review harness for the Fleet surface.
 *
 * The ribbon's states that carry design weight — a broadcast mid-flight, a supervised
 * run being watched, an inline destructive confirm, a partial-failure banner — are all
 * transient in the real app and mostly reachable only by launching several agents and
 * waiting. This mounts the real `FleetArmingRibbon`, `FleetDraftingPill` and
 * `FleetPickerPalette` against the real theme tokens and drives every state through
 * the same Zustand stores the app writes: the panel registry, the arming store, the
 * progress / run / pending-action / failure stores, the resolution-preview store.
 * Nothing about the components is mocked, so a shot is evidence about shipping code.
 *
 * What is a stand-in: the toolbar above the ribbon and the pane grid below it are
 * quiet blocks on the theme's canvas, there to give the ribbon its real neighbours.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?fixture=armed-3           which store state to seed (see FIXTURES)
 *   ?width=1100                frame width in CSS px
 */

interface FixtureDef {
  what: string;
  seed: () => void;
  /** Mount the cold-start picker palette instead of a bare ribbon. */
  palette?: boolean;
}

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "daintree",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
  {
    id: "wt-12383",
    worktreeId: "wt-12383",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12383",
    name: "issue-12383",
    branch: "bugfix/issue-12383-menu-rows-show-keyboard-focus",
    isCurrent: false,
  },
  {
    id: "wt-12381",
    worktreeId: "wt-12381",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12381",
    name: "issue-12381",
    branch: "bugfix/issue-12381-worktree-card-shows-pr-number",
    isCurrent: false,
  },
];

function pane(
  id: string,
  title: string,
  worktreeId: string,
  agentState: PtyPanelData["agentState"],
  extra: Partial<PtyPanelData> = {}
): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    cwd: "/Users/greg/Projects/daintree",
    cols: 120,
    rows: 40,
    detectedAgentId: "claude",
    worktreeId,
    projectId: "proj-daintree",
    location: "grid",
    agentState,
    hasPty: agentState !== "exited",
    ...extra,
  } as PtyPanelData;
}

// Realistic titles, including one long enough to truncate in the 260px armed
// list — the truncation bug class is invisible with short fixture labels.
const PANES: PtyPanelData[] = [
  pane("t-1", "claude · menu rows focus ring", "wt-12383", "working"),
  pane("t-2", "codex · stop menu rows ringing on mouse hover (#12383)", "wt-12383", "waiting", {
    waitingReason: "approval",
  }),
  pane("t-3", "gemini · worktree card PR number", "wt-12381", "waiting", {
    waitingReason: "question",
  }),
  pane("t-4", "claude · release notes", "wt-main", "working"),
  pane("t-5", "claude · flaky pty-host test", "wt-main", "exited"),
  pane("t-6", "zsh", "wt-main", undefined, { detectedAgentId: undefined }),
  pane("t-7", "codex · import budget ratchet", "wt-12383", "idle"),
  pane("t-8", "claude · theme text ramp", "wt-12381", "working"),
];

const SAVED_SCOPES: ProjectSettings["fleetSavedScopes"] = [
  {
    kind: "snapshot",
    id: "s-1",
    name: "Bugfix pair",
    terminalIds: ["t-1", "t-2"],
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 3_600_000,
  },
  {
    kind: "snapshot",
    id: "s-2",
    name: "Yesterday's review sweep",
    terminalIds: ["t-gone-1", "t-gone-2"],
    createdAt: Date.now() - 172_800_000,
  },
  {
    kind: "predicate",
    id: "p-1",
    name: "Everything waiting",
    scope: "all",
    stateFilter: "waiting",
    createdAt: Date.now() - 86_400_000,
  },
];

function seedBase(): void {
  const panelsById: Record<string, PtyPanelData> = {};
  const panelIds: string[] = [];
  for (const p of PANES) {
    panelsById[p.id] = p;
    panelIds.push(p.id);
  }
  usePanelStore.setState({ panelsById, panelIds, focusedId: "t-1" });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-12383" });
  const settings: ProjectSettings = { runCommands: [], fleetSavedScopes: SAVED_SCOPES };
  useProjectSettingsStore.setState({ settings });
}

function target(terminalId: string, overrides: Partial<FleetRunTarget> = {}): FleetRunTarget {
  const p = PANES.find((x) => x.id === terminalId);
  return {
    terminalId,
    title: p?.title ?? terminalId,
    worktreeId: p?.worktreeId ?? null,
    submission: "sent",
    agentState: p?.agentState ?? null,
    settled: false,
    gone: false,
    ...overrides,
  };
}

function seedRun(status: "watching" | "completed" | "failed"): void {
  useFleetRunStore.setState({
    run: {
      runId: "run-1",
      status,
      isRetry: false,
      draftPreview: "npm test -- src/components/Fleet",
      startedAt: Date.now() - 40_000,
      endedAt: status === "watching" ? undefined : Date.now(),
      targets: [
        target("t-1", { agentState: "working" }),
        target("t-4", { agentState: "working" }),
        target("t-2", { agentState: "waiting", settled: true }),
        target("t-3", { agentState: "idle", settled: true }),
        target("t-8", { agentState: "idle", settled: true }),
        target("t-7", { submission: "failed", failureKind: "transient", settled: true }),
      ],
    },
  });
}

const FIXTURES = {
  "armed-3": {
    what: "rest — three panes armed in one worktree",
    seed: () => useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-7"]),
  },
  "armed-cross-worktree": {
    what: "five panes across three worktrees, one exited — dots + scope suffixes",
    seed: () => useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-5"]),
  },
  "broadcast-running": {
    what: "large-paste fan-out mid-flight — progress counter and Cancel populate the centre",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-7", "t-8"]);
      const progress = useFleetBroadcastProgressStore.getState();
      progress.init(6);
      progress.advance(4, 0);
    },
  },
  "broadcast-running-failed": {
    what: "fan-out mid-flight with a rejection already counted",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-7", "t-8"]);
      const progress = useFleetBroadcastProgressStore.getState();
      progress.init(6);
      progress.advance(4, 1);
    },
  },
  "run-watching": {
    what: "supervised run being watched — live per-target counts",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-7", "t-8"]);
      seedRun("watching");
    },
  },
  "run-finished": {
    what: "supervised run finalized — dismissible summary",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-7", "t-8"]);
      seedRun("completed");
    },
  },
  "run-failed": {
    what: "supervised run that sent nothing",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3"]);
      seedRun("failed");
    },
  },
  "confirm-kill": {
    what: "inline destructive confirm — the duplicated ribbon shell",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4"]);
      useFleetPendingActionStore
        .getState()
        .request({ kind: "kill", targetCount: 4, sessionLossCount: 0 });
    },
  },
  "confirm-restart-loss": {
    what: "inline confirm with the longest message the builder produces",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4", "t-8"]);
      useFleetPendingActionStore
        .getState()
        .request({ kind: "restart", targetCount: 5, sessionLossCount: 3 });
    },
  },
  "failure-banner": {
    what: "partial broadcast failure — Tier-2 banner stacked above the ribbon",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4"]);
      useFleetFailureStore
        .getState()
        .recordFailure("npm test -- src/components/Fleet", ["t-3", "t-4"], 1);
    },
  },
  "failure-banner-confirm": {
    what: "failure banner still standing while a confirm is pending",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4"]);
      useFleetFailureStore.getState().recordFailure(null, ["t-3"], 0);
      useFleetPendingActionStore
        .getState()
        .request({ kind: "interrupt", targetCount: 4, sessionLossCount: 0 });
    },
  },
  "drafting-pill": {
    what: "the primary pane's drafting pill, popover closed",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-4"]);
      useFleetResolutionPreviewStore.getState().setDraft("Run the tests and report back");
    },
  },
  "drafting-pill-open": {
    what: "resolution popover open with a variable, an edited row and a skipped row",
    seed: () => {
      useFleetArmingStore.getState().armIds(["t-1", "t-2", "t-3", "t-5"]);
      const preview = useFleetResolutionPreviewStore.getState();
      preview.setDraft("Rebase {{branch_name}} onto develop and fix {{issue_number}}");
      preview.setOpen(true);
      const overrides = useFleetTargetOverridesStore.getState();
      overrides.setPayloadOverride("t-2", "Rebase onto develop only — skip the tests here");
      overrides.setSkipped("t-3", true);
    },
  },
  "picker-palette": {
    what: "cold-start picker palette over the grid",
    palette: true,
    seed: () => {},
  },
} satisfies Record<string, FixtureDef>;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(isFixtureName);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "armed-3";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "armed-3";
const width = Number(params.get("width")) || 1100;

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);

// Seed before the first render so no component ever sees the empty state
// and then transitions — the harness photographs a state, not an arrival.
seedBase();
FIXTURES[fixtureName].seed();

function Frame() {
  const fixture: FixtureDef = FIXTURES[fixtureName];
  const [paletteOpen, setPaletteOpen] = useState(fixture.palette === true);
  return (
    <div
      data-preview-frame
      data-fixture={fixtureName}
      className="flex flex-col bg-surface-canvas"
      style={{ width: `${width}px`, height: "640px" }}
    >
      {/* Stand-in for the toolbar the ribbon slides out from under. */}
      <div
        aria-hidden="true"
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border-default bg-surface-toolbar px-3"
      >
        <div className="h-2 w-16 rounded-full bg-overlay-soft" />
        <div className="h-2 w-24 rounded-full bg-overlay-soft" />
      </div>
      <FleetArmingRibbon />
      {/* Stand-in for the pane grid: one primary pane with its input bar, so the
          drafting pill sits where TerminalPane puts it. */}
      <div className="relative flex-1 min-h-0 p-2">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel">
          <div
            aria-hidden="true"
            className="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-2"
          >
            <div className="h-2 w-40 rounded-full bg-overlay-soft" />
          </div>
          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-0 z-30 pointer-events-none flex items-end justify-start pb-1.5 pl-[14px]">
              <div className="pointer-events-auto">
                <FleetDraftingPill />
              </div>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="m-2 h-8 shrink-0 rounded-[var(--radius-md)] border border-border-default bg-surface-input"
          />
        </div>
      </div>
      <FleetPickerPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
  return <Frame />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion strict features={motionFeatures}>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <App />
      </WorktreeStoreContext.Provider>
    </LazyMotion>
  </StrictMode>
);
