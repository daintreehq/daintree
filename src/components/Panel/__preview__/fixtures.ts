import type { AgentState, PanelKind, PersistableFlowStatus } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";

// Type-only imports, on purpose: the screenshot spec imports this catalogue under
// Playwright's Node loader, where anything that reaches Vite-only code
// (`import.meta.glob` in the agent icon registry) fails to evaluate. Runtime helpers
// that need product code live in `preview.tsx`.

/**
 * One pane's worth of props and store state, for the panel-header review harness.
 *
 * Everything the real `ContentPanel` reads to draw a header is either a prop it is
 * handed by the grid, or a row in one of four stores (`panelStore`, the per-view
 * worktree store, `fleetArmingStore`, `fleetFailureStore`). A fixture names both halves
 * so the preview can seed the stores and mount the pane exactly as the grid would.
 */
export interface PanelHeaderFixture {
  what: string;
  /** Pane width in CSS px. The grid's common 2×2 pane is ~560; 320 is the pressure case. */
  width?: number;
  kind: PanelKind;
  title: string;
  agentId?: string;
  agentState?: AgentState;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  isSelected?: boolean;
  isFleetFollower?: boolean;
  /** Seeds `fleetArmingStore.armedIds` — the RadioTower glyph and the fleet stripe read it. */
  armed?: boolean;
  /** Seeds `fleetArmingStore.previewArmedIds`. */
  previewed?: boolean;
  /** Seeds `fleetFailureStore.failedIds`. */
  fleetFailed?: boolean;
  /** Seeds `panelStore.watchedPanels`. */
  watched?: boolean;
  isHibernated?: boolean;
  isExited?: boolean;
  exitCode?: number | null;
  agentLaunchFlags?: string[];
  queueCount?: number;
  flowStatus?: PersistableFlowStatus;
  completedWithNoChanges?: boolean;
  lastCommand?: string;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  /** Extra fields written onto the panel-store row (cost, tokens, lock…). */
  panel?: Partial<PtyPanelData>;
  /** Preference overrides — the grid's agent-state frame cues are off by default. */
  prefs?: { showGridAgentHighlights?: boolean };
  /** Two worktrees in the view store makes the branch badge appear; this names the pane's. */
  branch?: string;
  /** Other grid panes seeded into the store — what Zen mode's background stats count. */
  background?: Array<{ agentState?: AgentState }>;
  tabs?: Array<{
    id: string;
    title: string;
    kind: PanelKind;
    agentId?: string;
    agentState?: AgentState;
    isActive?: boolean;
    hasDangerousFlags?: boolean;
  }>;
  /** Render the stand-in body as the plugin-missing placeholder instead of terminal lines. */
  body?: "terminal" | "plugin-missing" | "browser";
}

export const PANE_ID = "pane-under-review";
export const WORKTREE_ID = "wt-feature-auth";
export const OTHER_WORKTREE_ID = "wt-main";

const LONG_TITLE =
  "Claude: migrate the billing reconciliation worker off the legacy cron scheduler and onto the queue";

/**
 * The states that carry design weight. The first six are the ones a user sees on every
 * pane every day, and they are what the full 15-theme sweep captures; the rest are the
 * states nobody opens on purpose, which is exactly where a review finds things.
 */
export const FIXTURES = {
  "unfocused-working": {
    what: "the pane you are not looking at, agent busy — most panes, most of the time",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: false,
  },
  "focused-working": {
    what: "the pane you are typing into — title-bar lift, primary title, real brand colour",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
  },
  "selected-primary": {
    what: "armed fleet, this is the primary — focused AND selected, RadioTower armed glyph",
    kind: "terminal",
    title: "Codex: write funnel tests",
    agentId: "codex",
    agentState: "waiting",
    isFocused: true,
    isSelected: true,
    armed: true,
  },
  follower: {
    what: "armed fleet follower — lifted but unfocused, 2px amber stripe, will mirror keystrokes",
    kind: "terminal",
    title: "Gemini: audit accessibility",
    agentId: "gemini",
    agentState: "working",
    isFocused: false,
    isSelected: true,
    isFleetFollower: true,
    armed: true,
  },
  "preview-hover": {
    what: "fleet menu hover preview — the faint neutral tint that says 'this one would arm'",
    kind: "terminal",
    title: "Claude: refactor to TypeScript",
    agentId: "claude",
    agentState: "working",
    isFocused: false,
    previewed: true,
  },
  "maximized-stats": {
    what: "Zen mode with three panes in the background, one working and one waiting",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    isMaximized: true,
    width: 900,
    background: [{ agentState: "working" }, { agentState: "waiting" }, {}],
  },
  "maximized-quiet": {
    what: "Zen mode with nothing in the background — no centred stats",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    isMaximized: true,
    width: 900,
  },
  dock: {
    what: "a dock preview — identity title, 'Move to grid' control, close reads 'Dismiss preview'",
    kind: "terminal",
    title: "Claude",
    agentId: "claude",
    agentState: "waiting",
    isFocused: true,
    location: "dock",
  },
  "waiting-blocked": {
    what: "agent waiting on the user — amber glyph, and with grid highlights on the frame goes panel-state-waiting after 800ms",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "waiting",
    isFocused: false,
    prefs: { showGridAgentHighlights: true },
  },
  "completed-cost": {
    what: "agent finished with a cost on record — what the header shows once the run has settled",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "completed",
    isFocused: false,
    panel: { sessionCost: 1.84, sessionTokens: 128_400 },
  },
  "completed-no-changes": {
    what: "agent finished without touching the tree — what the header shows for that",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "completed",
    isFocused: false,
    completedWithNoChanges: true,
  },
  "exited-plain": {
    what: "a plain shell that exited non-zero — exit code badge, no agent chrome",
    kind: "terminal",
    title: "zsh",
    isFocused: false,
    isExited: true,
    exitCode: 1,
  },
  hibernated: {
    what: "renderer asleep — dashed Moon pill, hibernated frame cue",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: false,
    isHibernated: true,
  },
  "fleet-failed": {
    what: "last fleet broadcast rejected here — red dot beside the title, still armed",
    kind: "terminal",
    title: "Codex: write funnel tests",
    agentId: "codex",
    agentState: "working",
    isFocused: false,
    isSelected: true,
    isFleetFollower: true,
    armed: true,
    fleetFailed: true,
  },
  "dense-metadata": {
    what: "everything at once — dangerous flags, watched, branch badge, queue, lock, cost",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    agentLaunchFlags: ["--dangerously-skip-permissions"],
    watched: true,
    branch: "feature/auth-redirect",
    queueCount: 2,
    panel: { isInputLocked: true, sessionCost: 4.2, sessionTokens: 412_000 },
  },
  "long-title-narrow": {
    what: "the pressure case — a long task title with a branch badge in a 320px pane",
    kind: "terminal",
    title: LONG_TITLE,
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    width: 320,
    branch: "feature/billing-reconciliation-worker",
    panel: { sessionCost: 0.42, sessionTokens: 31_000 },
  },
  "status-slot": {
    what: "output paused for backpressure — the fixed status box ahead of the controls lights",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    flowStatus: "paused-backpressure",
    panel: { heldDurationMs: 12_000 },
  },
  "command-pill": {
    what: "a plain terminal running a command — the command pill",
    kind: "terminal",
    title: "zsh",
    isFocused: true,
    activityStatus: "working",
    lastCommand: "npm run build",
  },
  tabs: {
    what: "a tab group — three tabs, one active, states on the others",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    tabs: [
      {
        id: "tab-1",
        title: "fix flaky auth tests",
        kind: "terminal",
        agentId: "claude",
        agentState: "working",
        isActive: true,
      },
      {
        id: "tab-2",
        title: "write funnel tests",
        kind: "terminal",
        agentId: "codex",
        agentState: "waiting",
      },
      { id: "tab-3", title: "localhost:5173", kind: "browser" },
    ],
  },
  "tabs-overflow": {
    what: "the same tab group at 320px — tabs hide behind the chevron",
    kind: "terminal",
    title: "Claude: fix flaky auth tests",
    agentId: "claude",
    agentState: "working",
    isFocused: true,
    width: 320,
    tabs: [
      {
        id: "tab-1",
        title: "fix flaky auth tests",
        kind: "terminal",
        agentId: "claude",
        agentState: "working",
        isActive: true,
      },
      {
        id: "tab-2",
        title: "write funnel tests",
        kind: "terminal",
        agentId: "codex",
        agentState: "waiting",
      },
      {
        id: "tab-3",
        title: "audit accessibility",
        kind: "terminal",
        agentId: "gemini",
        agentState: "working",
      },
      { id: "tab-4", title: "localhost:5173", kind: "browser" },
    ],
  },
  browser: {
    what: "a non-terminal kind — no status box, no glyph box, the controls sit flush",
    kind: "browser",
    title: "localhost:5173",
    isFocused: true,
    body: "browser",
  },
  "plugin-missing": {
    what: "a plugin panel whose kind is gone — the placeholder body under an ordinary header",
    kind: "terminal",
    title: "GitHub pull requests",
    isFocused: false,
    body: "plugin-missing",
  },
} satisfies Record<string, PanelHeaderFixture>;

export type FixtureName = keyof typeof FIXTURES;

/** A predicate, not an assertion — a query parameter is arbitrary input. */
export function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(isFixtureName);

/** The six states every pane shows every day — what the full theme sweep captures. */
export const CORE_FIXTURES: FixtureName[] = [
  "unfocused-working",
  "focused-working",
  "selected-primary",
  "follower",
  "preview-hover",
  "waiting-blocked",
];
