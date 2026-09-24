import type { PanelHeaderFixture } from "./fixtures";

// Type-only imports, for the same reason as `fixtures.ts`: the screenshot spec
// loads this under Playwright's Node loader.

/** What the stand-in body under a grid pane shows. */
export type GridBody =
  "agent-working" | "agent-idle" | "shell" | "file-tree" | "code" | "diff" | "browser" | "review";

export interface GridPane extends Omit<PanelHeaderFixture, "what" | "width" | "body"> {
  id: string;
  body: GridBody;
}

/**
 * A whole grid, for the question a single pane cannot answer: how the panes read
 * next to each other — the gutter, the frames, which one has focus, and whether a
 * row of headers tells the panes apart.
 */
export interface GridScene {
  what: string;
  cols: number;
  width: number;
  height: number;
  panes: GridPane[];
  /**
   * Draw the two-pane split instead of the column grid: the left pane's share of
   * the width, with the real divider in its own track between the two panes.
   */
  split?: number;
}

export const GRID_SCENES = {
  "claude-trio": {
    what: "the reported screen — three Claude panes, one working on a task, two idle",
    cols: 3,
    width: 1500,
    height: 360,
    panes: [
      {
        id: "g-claude-1",
        kind: "terminal",
        title: "Claude: Wait 15 minutes then merge PRs",
        agentId: "claude",
        agentState: "working",
        isFocused: true,
        body: "agent-working",
      },
      {
        id: "g-claude-2",
        kind: "terminal",
        title: "Claude",
        agentId: "claude",
        agentState: "waiting",
        isFocused: false,
        body: "agent-idle",
      },
      {
        id: "g-claude-3",
        kind: "terminal",
        title: "Claude",
        agentId: "claude",
        agentState: "waiting",
        isFocused: false,
        body: "agent-idle",
      },
    ],
  },
  "mixed-agents": {
    what: "six different agents in a 3×2 grid — the header row has to tell them apart",
    cols: 3,
    width: 1500,
    height: 560,
    panes: [
      {
        id: "g-mixed-claude",
        kind: "terminal",
        title: "Claude: fix flaky auth tests",
        agentId: "claude",
        agentState: "working",
        isFocused: true,
        body: "agent-working",
      },
      {
        id: "g-mixed-codex",
        kind: "terminal",
        title: "Codex: write funnel tests",
        agentId: "codex",
        agentState: "waiting",
        isFocused: false,
        body: "agent-idle",
      },
      {
        id: "g-mixed-gemini",
        kind: "terminal",
        title: "Gemini: audit accessibility",
        agentId: "gemini",
        agentState: "completed",
        isFocused: false,
        body: "agent-working",
      },
      {
        id: "g-mixed-opencode",
        kind: "terminal",
        title: "OpenCode",
        agentId: "opencode",
        agentState: "idle",
        isFocused: false,
        body: "agent-idle",
      },
      {
        id: "g-mixed-cursor",
        kind: "terminal",
        title: "Cursor: migrate billing worker",
        agentId: "cursor",
        agentState: "working",
        isFocused: false,
        body: "agent-working",
      },
      {
        id: "g-mixed-copilot",
        kind: "terminal",
        title: "Copilot: update changelog",
        agentId: "copilot",
        agentState: "working",
        isFocused: false,
        body: "agent-working",
      },
    ],
  },
  kinds: {
    what: "one of each non-agent kind — shell, file browser, editor, diff, browser, review",
    cols: 3,
    width: 1500,
    height: 560,
    panes: [
      {
        id: "g-kind-shell",
        kind: "terminal",
        title: "zsh",
        isFocused: false,
        activityStatus: "working",
        lastCommand: "npm run dev",
        body: "shell",
      },
      {
        id: "g-kind-files",
        kind: "file-browser",
        title: "acme-platform",
        isFocused: true,
        body: "file-tree",
      },
      {
        id: "g-kind-file",
        kind: "file",
        title: "session.ts",
        isFocused: false,
        body: "code",
      },
      {
        id: "g-kind-diff",
        kind: "diff",
        title: "session.ts (working tree)",
        isFocused: false,
        body: "diff",
      },
      {
        id: "g-kind-browser",
        kind: "browser",
        title: "localhost:5173",
        isFocused: false,
        body: "browser",
      },
      {
        id: "g-kind-review",
        kind: "review",
        title: "Review: feature/auth-redirect",
        isFocused: false,
        body: "review",
      },
    ],
  },
  "fleet-quad": {
    what: "a 2×2 working session — armed fleet primary and follower, a waiting pane, a shell",
    cols: 2,
    width: 1200,
    height: 560,
    panes: [
      {
        id: "g-fleet-primary",
        kind: "terminal",
        title: "Claude: fix flaky auth tests",
        agentId: "claude",
        agentState: "working",
        isFocused: true,
        isSelected: true,
        armed: true,
        branch: "feature/auth-redirect",
        body: "agent-working",
      },
      {
        id: "g-fleet-follower",
        kind: "terminal",
        title: "Codex: write funnel tests",
        agentId: "codex",
        agentState: "working",
        isFocused: false,
        isSelected: true,
        isFleetFollower: true,
        armed: true,
        body: "agent-working",
      },
      {
        id: "g-fleet-waiting",
        kind: "terminal",
        title: "Gemini: audit accessibility",
        agentId: "gemini",
        agentState: "waiting",
        isFocused: false,
        body: "agent-idle",
        panel: { sessionCost: 0.84, sessionTokens: 61_000 },
      },
      {
        id: "g-fleet-shell",
        kind: "terminal",
        title: "zsh",
        isFocused: false,
        isExited: true,
        exitCode: 1,
        body: "shell",
      },
    ],
  },
  "dense-four": {
    what: "four columns — the narrowest panes the grid makes, where the compact title takes over",
    cols: 4,
    width: 1500,
    height: 360,
    panes: [
      {
        id: "g-dense-1",
        kind: "terminal",
        title: "Claude: migrate the billing reconciliation worker off cron",
        agentId: "claude",
        agentState: "working",
        isFocused: true,
        body: "agent-working",
      },
      {
        id: "g-dense-2",
        kind: "terminal",
        title: "Codex: write funnel tests",
        agentId: "codex",
        agentState: "waiting",
        isFocused: false,
        agentLaunchFlags: ["--dangerously-bypass-approvals-and-sandbox"],
        body: "agent-idle",
      },
      {
        id: "g-dense-3",
        kind: "file-browser",
        title: "acme-platform",
        isFocused: false,
        body: "file-tree",
      },
      {
        id: "g-dense-4",
        kind: "terminal",
        title: "zsh",
        isFocused: false,
        body: "shell",
      },
    ],
  },
  "split-agent-browser": {
    what: "the two-pane split — an agent beside the page it is building, at the preview-first ratio",
    cols: 2,
    width: 1400,
    height: 560,
    split: 0.35,
    panes: [
      {
        id: "g-split-claude",
        kind: "terminal",
        title: "Claude: Fix the login redirect loop",
        agentId: "claude",
        agentState: "working",
        isFocused: true,
        body: "agent-working",
      },
      {
        id: "g-split-browser",
        kind: "browser",
        title: "localhost:5173",
        isFocused: false,
        body: "browser",
      },
    ],
  },
  "split-two-agents": {
    what: "the two-pane split at an even ratio — two terminals, the divider between like panes",
    cols: 2,
    width: 1400,
    height: 560,
    split: 0.5,
    panes: [
      {
        id: "g-split-codex",
        kind: "terminal",
        title: "Codex: write funnel tests",
        agentId: "codex",
        agentState: "waiting",
        isFocused: false,
        body: "agent-idle",
      },
      {
        id: "g-split-shell",
        kind: "terminal",
        title: "zsh",
        isFocused: true,
        body: "shell",
      },
    ],
  },
} satisfies Record<string, GridScene>;

export type GridSceneName = keyof typeof GRID_SCENES;

export function isGridSceneName(value: string): value is GridSceneName {
  return Object.prototype.hasOwnProperty.call(GRID_SCENES, value);
}

export const GRID_SCENE_NAMES = Object.keys(GRID_SCENES).filter(isGridSceneName);
