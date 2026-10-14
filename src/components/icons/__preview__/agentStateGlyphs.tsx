import "./agentStateGlyphsShims";
import "@/lib/trustedTypesPolicy";
import { StrictMode, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import {
  AskingCircle,
  BlockedCircle,
  DoneCircle,
  ExitedCircle,
  HollowCircle,
  IdleCircle,
  InteractingCircle,
  ParkedCircle,
  SnoozedCircle,
  SpinnerCircle,
  UnreadCircle,
} from "@/components/icons";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { ContentDock } from "@/components/Layout/ContentDock";
import { DockPanelOffscreenContainer } from "@/components/Layout/DockPanelOffscreenContainer";
import { WorktreeTerminalSection } from "@/components/Worktree/WorktreeCard/WorktreeTerminalSection";
import { QuickStateFilterBar } from "@/components/Worktree/QuickStateFilterBar";
import { QuickStateArmButton } from "@/components/Worktree/QuickStateArmButton";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { PilotFilterBar } from "@/components/Pilot/PilotFilterBar";
import type { PilotBandFilter, PilotBandFilterCounts } from "@/components/Pilot/pilotRows";
import { emptyBandCounts, type FleetBand, type FleetBandCounts } from "@/lib/fleetAttention";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import { aggregateAgentStates, type WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import { handBackStateForRun } from "@/lib/handBackPresentation";
import "@/index.css";

// Dynamic rather than static so the harness entry obeys the app's lazy-load rule
// (#7659); the sortable session rows render through `m.div`.
const { LazyMotion, domAnimation } = await import("framer-motion");

/**
 * Standalone visual-review harness for the agent-state glyph family, on every
 * surface that draws it: the glyphs alone at each size they ship at and
 * magnified over their geometry, the REAL pane header (`ContentPanel`), the
 * REAL sidebar session list and its collapsed summary, the REAL quick-state
 * bar, Pilot's REAL row glyphs and filter bar, and the REAL dock strip.
 *
 * Hand-backs reach the glyphs the way they do in the app: through the fleet
 * snapshot store, which is what turns a prompt wait into unread or finished.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const WORKTREE_ID = "wt-glyphs";
const now = Date.now();

type PaneSpec = {
  id: string;
  title: string;
  agentId?: "claude" | "codex";
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  location: "grid" | "dock";
  sessionCost?: number;
  isExited?: boolean;
};

/** Each state the glyph family draws, as a pane would carry it. */
const HEADER_PANES: PaneSpec[] = [
  {
    id: "hdr-working",
    title: "Claude",
    agentId: "claude",
    agentState: "working",
    location: "grid",
  },
  {
    id: "hdr-waiting",
    title: "Claude",
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "approval",
    location: "grid",
  },
  {
    id: "hdr-directing",
    title: "Claude",
    agentId: "claude",
    agentState: "directing",
    location: "grid",
  },
  {
    id: "hdr-unread",
    title: "Claude",
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    location: "grid",
  },
  {
    id: "hdr-finished",
    title: "Claude",
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    location: "grid",
  },
];

const DOCK_PANES: PaneSpec[] = [
  { id: "d-working", title: "Claude", agentId: "claude", agentState: "working", location: "dock" },
  {
    id: "d-waiting",
    title: "Codex",
    agentId: "codex",
    agentState: "waiting",
    waitingReason: "approval",
    location: "dock",
  },
  {
    id: "d-directing",
    title: "Claude",
    agentId: "claude",
    agentState: "directing",
    location: "dock",
  },
  {
    id: "d-unread",
    title: "Claude",
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    location: "dock",
  },
  {
    id: "d-finished",
    title: "Codex",
    agentId: "codex",
    agentState: "waiting",
    waitingReason: "prompt",
    location: "dock",
  },
  {
    id: "d-exited",
    title: "Claude",
    agentId: "claude",
    agentState: "exited",
    location: "dock",
    isExited: true,
  },
];

/** Prompt waits the fleet holds a hand-back for: unseen draws unread, seen draws finished. */
const HAND_BACKS: Record<string, "unseen" | "seen"> = {
  "hdr-unread": "unseen",
  "hdr-finished": "seen",
  "d-unread": "unseen",
  "d-finished": "seen",
};

function toPanel(spec: PaneSpec): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture: only the fields the chrome reads
  return {
    id: spec.id,
    kind: "terminal",
    title: spec.title,
    location: spec.location,
    cwd: "/Users/dev/daintree",
    cols: 120,
    rows: 40,
    worktreeId: WORKTREE_ID,
    projectId: "proj-daintree",
    hasPty: true,
    ...(spec.agentId ? { launchAgentId: spec.agentId, detectedAgentId: spec.agentId } : {}),
    agentState: spec.agentState,
    waitingReason: spec.waitingReason,
    lastStateChange: now - 65_000,
    startedAt: now - 600_000,
    sessionCost: spec.sessionCost,
    isExited: spec.isExited,
  } as PanelInstance;
}

const panels = [...HEADER_PANES, ...DOCK_PANES].map(toPanel);

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture: only the fields the hand-back index reads
const fleet = {
  runs: Object.entries(HAND_BACKS).map(([runId, seen]) => {
    const spec = [...HEADER_PANES, ...DOCK_PANES].find((p) => p.id === runId)!;
    return {
      runId,
      workspaceId: "proj-daintree",
      worktreeId: WORKTREE_ID,
      agentId: spec.agentId,
      agentState: spec.agentState,
      waitingReason: spec.waitingReason,
      spawnedAt: now - 600_000,
      cwd: "/Users/dev/daintree",
      handBack:
        seen === "seen"
          ? { stoppedAt: now - 60_000, seenAt: now - 30_000 }
          : { stoppedAt: now - 60_000 },
    };
  }),
  lastChangedAt: now,
} as unknown as FleetSnapshot;

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: WORKTREE_ID,
    worktreeId: WORKTREE_ID,
    path: "/Users/dev/daintree",
    name: "daintree",
    branch: "develop",
    isCurrent: true,
  },
];

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);
useWorktreeSelectionStore.setState({ activeWorktreeId: WORKTREE_ID });
usePluginContextMenuItemsStore.setState({ entries: [], init() {} });
usePanelStore.setState({
  panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  panelIds: panels.map((p) => p.id),
});
useFleetSnapshotStore.setState({ snapshot: fleet });

const noop = () => {};

function Section({ shot, title, children }: { shot: string; title: string; children: ReactNode }) {
  return (
    <section data-shot={shot} className="flex w-fit flex-col gap-2 bg-surface-canvas p-4">
      <div className="font-mono text-2xs text-text-muted">{title}</div>
      {children}
    </section>
  );
}

type Glyph = ComponentType<{ className?: string }>;

/** The family as every surface draws it; blocked to idle are Pilot's band marks, cmd done the dock's plain-terminal cue. */
const FAMILY: { label: string; Icon: Glyph; tone: string; spin?: boolean }[] = [
  { label: "working", Icon: SpinnerCircle, tone: "text-state-working", spin: true },
  { label: "waiting", Icon: HollowCircle, tone: "text-state-waiting" },
  { label: "asking", Icon: AskingCircle, tone: "text-state-waiting" },
  { label: "directing", Icon: InteractingCircle, tone: "text-category-blue" },
  { label: "unread", Icon: UnreadCircle, tone: "text-text-primary" },
  { label: "finished", Icon: DoneCircle, tone: "text-text-secondary" },
  { label: "exited", Icon: ExitedCircle, tone: "text-text-secondary" },
  { label: "blocked", Icon: BlockedCircle, tone: "text-status-danger" },
  { label: "parked", Icon: ParkedCircle, tone: "text-text-secondary" },
  { label: "snoozed", Icon: SnoozedCircle, tone: "text-text-secondary" },
  { label: "idle", Icon: IdleCircle, tone: "text-text-secondary" },
  { label: "cmd done", Icon: DoneCircle, tone: "text-status-success" },
];

function FamilyRow({ size }: { size: string }) {
  return (
    <div className="flex items-end gap-3">
      {FAMILY.map(({ label, Icon, tone, spin }) => (
        <div key={label} className="flex w-14 flex-col items-center gap-1">
          <span className={tone}>
            <Icon className={`${size} ${spin ? "animate-spin-slow" : ""}`} />
          </span>
          <span className="text-[10px] text-text-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Magnified over a guide: the dashed circle is the spinner's outer edge
 * (r 6.667 of the 16-unit box) and the hairlines cross at the box's centre, so
 * a glyph that overshoots, undershoots or sits off-centre shows against them.
 */
function Geometry() {
  return (
    <div className="grid grid-cols-6 gap-3">
      {FAMILY.map(({ label, Icon, tone }) => (
        <div key={label} className="flex flex-col items-center gap-1">
          <div className="relative h-24 w-24 bg-surface-panel">
            <svg viewBox="0 0 16 16" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r="6.667"
                fill="none"
                stroke="var(--color-status-danger)"
                strokeWidth="0.06"
                strokeDasharray="0.3 0.2"
              />
              <line
                x1="8"
                y1="0"
                x2="8"
                y2="16"
                stroke="var(--color-border-strong)"
                strokeWidth="0.04"
              />
              <line
                x1="0"
                y1="8"
                x2="16"
                y2="8"
                stroke="var(--color-border-strong)"
                strokeWidth="0.04"
              />
            </svg>
            <span className={`absolute inset-0 ${tone}`}>
              <Icon className="h-24 w-24" />
            </span>
          </div>
          <span className="text-[10px] text-text-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}

function HeaderRow({ spec }: { spec: PaneSpec }) {
  return (
    <div data-header-row={spec.id} style={{ width: 460, height: 40 }}>
      <ContentPanel
        id={spec.id}
        title={spec.title}
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
        agentId={spec.agentId}
        detectedAgentId={spec.agentId}
        agentState={spec.agentState}
        onAddTab={noop}
      >
        <div className="flex-1" />
      </ContentPanel>
    </div>
  );
}

const sessionTerminals = DOCK_PANES.map(toPanel) as PtyPanelData[];
// Counted the way the sidebar counts them, hand-backs included, so the collapsed
// summary shows what the app would and not what a fixture claims.
const { byState, unread } = aggregateAgentStates(sessionTerminals, (id) =>
  handBackStateForRun(fleet, id)
);
const sessionCounts: WorktreeTerminalCounts = { total: DOCK_PANES.length, byState, unread };

function Sessions({ expanded }: { expanded: boolean }) {
  return (
    <div className="w-[300px] bg-surface-sidebar px-3 py-2">
      <WorktreeTerminalSection
        variant="sidebar"
        worktreeId={WORKTREE_ID}
        onStartSession={noop}
        isExpanded={expanded}
        counts={sessionCounts}
        terminals={sessionTerminals}
        onToggle={noop}
        onTerminalSelect={noop}
      />
    </div>
  );
}

function QuickBar({
  counts,
  unseen,
}: {
  counts: Record<QuickStateFilter, number>;
  unseen: number;
}) {
  const [value, setValue] = useState<QuickStateFilter>("all");
  return (
    <div className="w-[300px] bg-surface-sidebar">
      <QuickStateFilterBar
        value={value}
        onChange={setValue}
        counts={counts}
        finishedUnseen={unseen}
        trailing={<QuickStateArmButton label="Arm all 4 agents" disabled={false} onArm={noop} />}
      />
    </div>
  );
}

const PILOT_ROWS: { band: FleetBand; agentState: AgentState | undefined; label: string }[] = [
  { band: "running", agentState: "working", label: "running" },
  { band: "running", agentState: "directing", label: "directing" },
  { band: "needs-you", agentState: "waiting", label: "needs you" },
  { band: "blocked", agentState: "waiting", label: "blocked" },
  { band: "quiet", agentState: "working", label: "quiet" },
  { band: "review", agentState: "waiting", label: "unread" },
  { band: "done", agentState: "completed", label: "done" },
  { band: "parked", agentState: "waiting", label: "parked" },
  { band: "snoozed", agentState: "waiting", label: "snoozed" },
  { band: "idle", agentState: "idle", label: "idle" },
  { band: "idle", agentState: "exited", label: "exited" },
];

function bands(overrides: Partial<FleetBandCounts>): FleetBandCounts {
  return { ...emptyBandCounts(), ...overrides };
}

const PILOT_COUNTS: PilotBandFilterCounts = {
  all: 11,
  "needs-you": 2,
  quiet: 1,
  working: 2,
  finished: 2,
  parked: 2,
  other: 2,
};

function PilotBar({ review }: { review: number }) {
  const [value, setValue] = useState<PilotBandFilter>("all");
  return (
    <div className="w-[560px] bg-surface-panel">
      <PilotFilterBar
        value={value}
        counts={PILOT_COUNTS}
        bands={bands({
          "needs-you": 1,
          blocked: 1,
          quiet: 1,
          running: 2,
          review,
          done: 2 - review,
        })}
        onChange={setValue}
      />
    </div>
  );
}

function Sheet() {
  return (
    <div data-preview-root className="flex w-fit flex-col gap-2 bg-surface-canvas">
      <Section shot="family" title="family at 16px / 14px / 12px / 10px">
        <FamilyRow size="h-4 w-4" />
        <FamilyRow size="h-3.5 w-3.5" />
        <FamilyRow size="h-3 w-3" />
        <FamilyRow size="h-2.5 w-2.5" />
      </Section>
      <Section shot="geometry" title="geometry — dashed ring is the spinner's outer edge">
        <Geometry />
      </Section>
      <Section
        shot="title-bar"
        title="pane title bar — working, waiting (approval), directing, unread, finished"
      >
        <div className="flex flex-col gap-2">
          {HEADER_PANES.map((spec) => (
            <HeaderRow key={spec.id} spec={spec} />
          ))}
        </div>
      </Section>
      <Section shot="sidebar" title="sidebar sessions — expanded and collapsed">
        <Sessions expanded />
        <Sessions expanded={false} />
      </Section>
      <Section shot="quick-state" title="quick-state bar — 0 finished / 3 read / 3 with 1 unread">
        <QuickBar counts={{ all: 3, working: 2, waiting: 1, finished: 0 }} unseen={0} />
        <QuickBar counts={{ all: 6, working: 2, waiting: 1, finished: 3 }} unseen={0} />
        <QuickBar counts={{ all: 6, working: 2, waiting: 1, finished: 3 }} unseen={1} />
      </Section>
      <Section shot="pilot" title="pilot — row glyphs and filter bar (with and without unread)">
        <div className="flex items-center gap-3 bg-surface-panel px-3 py-2">
          {PILOT_ROWS.map((row) => (
            <div key={row.label} className="flex items-center gap-1.5">
              <PilotRunState band={row.band} agentState={row.agentState} />
              <span className="text-xs text-text-secondary">{row.label}</span>
            </div>
          ))}
        </div>
        <PilotBar review={1} />
        <PilotBar review={0} />
      </Section>
      <Section shot="dock" title="dock — working, waiting, directing, unread, finished, exited">
        <aside aria-label="Dock" data-dock-frame className="w-[1180px]">
          <DockPanelOffscreenContainer>
            <ContentDock density="normal" />
          </DockPanelOffscreenContainer>
        </aside>
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={worktreeStore}>
          <DndContext>
            <Sheet />
          </DndContext>
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
