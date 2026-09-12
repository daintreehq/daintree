import type { PanelInstance, PanelKind, PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import type { WorktreeSnapshot } from "@shared/types";

/**
 * Fixture data for the drag-drop visual-review harness. Everything here is
 * shaped to exercise exactly what the ghosts and placeholders read — kind,
 * title, agent identity and state, group size — with realistic labels, because
 * a sparse fixture hides the truncation and colour defects the harness exists
 * to find.
 */

interface PtyOptions {
  agentId?: string;
  agentState?: AgentState;
}

// The preview never persists or dispatches these, so the store-owned fields a
// real PanelInstance carries (cwd, pid, cols/rows, worktree binding) are filled
// with inert values and non-PTY kinds are widened through the same cast.
export function ptyPanel(id: string, title: string, opts: PtyOptions = {}): PanelInstance {
  const raw = {
    id,
    kind: "terminal",
    title,
    location: "grid",
    isVisible: true,
    cwd: "/Users/dev/Projects/surge-checkout",
    cols: 120,
    rows: 40,
    ...(opts.agentId
      ? {
          launchAgentId: opts.agentId,
          runtimeIdentity: {
            kind: "agent",
            id: opts.agentId,
            iconId: opts.agentId,
            agentId: opts.agentId,
          },
        }
      : {}),
    ...(opts.agentState ? { agentState: opts.agentState } : {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture, see above
  return raw as unknown as PtyPanelData;
}

export function kindPanel(kind: PanelKind, id: string, title: string): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture, see above
  return { id, kind, title, location: "grid", isVisible: true } as unknown as PanelInstance;
}

export interface GhostFixture {
  what: string;
  terminal: PanelInstance;
  groupTabCount?: number;
}

/** Every distinct thing a panel drag ghost can be asked to represent. */
export const GHOSTS: Record<string, GhostFixture> = {
  shell: {
    what: "a plain shell — the default, no agent chrome",
    terminal: ptyPanel("p-shell", "zsh — surge-checkout"),
  },
  "claude-working": {
    what: "an agent mid-task: brand colour + spinning working glyph",
    terminal: ptyPanel("p-claude-w", "Refund pipeline", {
      agentId: "claude",
      agentState: "working",
    }),
  },
  "claude-waiting": {
    what: "an agent waiting on the user: amber hollow circle",
    terminal: ptyPanel("p-claude-i", "Refund pipeline", {
      agentId: "claude",
      agentState: "waiting",
    }),
  },
  "codex-directing": {
    what: "a second agent brand, user-intervention state",
    terminal: ptyPanel("p-codex", "Webhook router audit", {
      agentId: "codex",
      agentState: "directing",
    }),
  },
  "gemini-group": {
    what: "a three-tab group — the count badge",
    terminal: ptyPanel("p-gemini", "Checkout tests", {
      agentId: "gemini",
      agentState: "working",
    }),
    groupTabCount: 3,
  },
  "exited-agent": {
    what: "an agent that exited — chrome demotes to a plain terminal",
    terminal: ptyPanel("p-exited", "Refund pipeline", {
      agentId: "claude",
      agentState: "exited",
    }),
  },
  "long-title": {
    what: "a title long enough to force the ellipsis",
    terminal: ptyPanel(
      "p-long",
      "Investigate the intermittent ECONNRESET on the refund webhook retry path and propose a fix",
      { agentId: "claude", agentState: "working" }
    ),
  },
  browser: {
    what: "browser panel",
    terminal: kindPanel("browser", "p-browser", "localhost:5173/checkout"),
  },
  "dev-preview": {
    what: "dev preview panel",
    terminal: kindPanel("dev-preview", "p-devp", "npm run dev"),
  },
  review: {
    what: "review hub panel",
    terminal: kindPanel("review", "p-review", "Review — feature/refund-flow"),
  },
  file: {
    what: "file viewer panel — has no illustration of its own today",
    terminal: kindPanel("file", "p-file", "src/checkout.ts"),
  },
  "file-browser": {
    what: "file browser panel — has no illustration of its own today",
    terminal: kindPanel("file-browser", "p-fb", "surge-checkout"),
  },
  diff: {
    what: "diff panel — has no illustration of its own today",
    terminal: kindPanel("diff", "p-diff", "src/refund.ts"),
  },
  plugin: {
    what: "a plugin-contributed kind the registry has never heard of",
    terminal: kindPanel("sticky-notes", "p-plugin", "Sticky notes"),
  },
};

export interface WorktreeGhostFixture {
  what: string;
  worktree: WorktreeSnapshot;
}

function worktree(overrides: Partial<WorktreeSnapshot> & { id: string }): WorktreeSnapshot {
  const raw = {
    name: overrides.id,
    path: `/Users/dev/Projects/surge-checkout-worktrees/${overrides.id}`,
    isCurrent: false,
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture, see above
  return raw as WorktreeSnapshot;
}

/** Every distinct thing a worktree-row drag ghost can be asked to represent. */
export const WORKTREE_GHOSTS: Record<string, WorktreeGhostFixture> = {
  issue: {
    what: "a worktree bound to an issue — title line plus branch line",
    worktree: worktree({
      id: "wt-142",
      name: "issue-142-refund-flow",
      branch: "feature/issue-142-refund-flow",
      issueNumber: 142,
      issueTitle: "Add idempotent partial refunds",
    }),
  },
  "branch-only": {
    what: "a plain branch — single line with the folder glyph",
    worktree: worktree({
      id: "wt-auth",
      name: "bugfix-auth-redirect",
      branch: "bugfix/auth-redirect",
    }),
  },
  main: {
    what: "the main worktree — shows its folder name, not the branch",
    worktree: worktree({
      id: "wt-main",
      name: "surge-checkout",
      branch: "main",
      isMainWorktree: true,
    }),
  },
  "long-issue": {
    what: "an issue title long enough to force the ellipsis on both lines",
    worktree: worktree({
      id: "wt-long",
      name: "issue-188-webhook",
      branch: "feature/issue-188-webhook-router-retry-with-exponential-backoff",
      issueNumber: 188,
      issueTitle:
        "Webhook router should retry with exponential backoff and surface the final failure",
    }),
  },
};

/**
 * The kinds a drop placeholder can be asked to stand in for. `agent` is a
 * terminal with an agent identity — the placeholder's colour comes from the
 * agent, not the kind.
 */
export const PLACEHOLDER_KINDS = [
  "terminal",
  "agent",
  "browser",
  "dev-preview",
  "review",
  "file",
  "file-browser",
  "diff",
  "plugin",
] as const;

export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export function placeholderPanel(kind: PlaceholderKind): PanelInstance {
  switch (kind) {
    case "terminal":
      return GHOSTS.shell!.terminal;
    case "agent":
      return GHOSTS["claude-working"]!.terminal;
    default:
      return GHOSTS[kind]!.terminal;
  }
}

/** Panels that populate the grid and dock around a placeholder. */
export const NEIGHBOURS: PanelInstance[] = [
  ptyPanel("n-1", "Refund pipeline", { agentId: "claude", agentState: "working" }),
  ptyPanel("n-2", "zsh — surge-checkout"),
  kindPanel("browser", "n-3", "localhost:5173/checkout"),
  ptyPanel("n-4", "Checkout tests", { agentId: "codex", agentState: "waiting" }),
];

export const SIDEBAR_ROWS: WorktreeSnapshot[] = [
  WORKTREE_GHOSTS.issue!.worktree,
  WORKTREE_GHOSTS["branch-only"]!.worktree,
  worktree({
    id: "wt-assets",
    name: "feature-asset-library",
    branch: "feature/asset-library",
    issueNumber: 97,
    issueTitle: "Asset library CDN sync",
  }),
];
