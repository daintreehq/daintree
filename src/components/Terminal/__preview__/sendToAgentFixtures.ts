import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

/**
 * Fixtures for the send-to-agent palette review harness.
 *
 * Panes are real panel records, pushed through the panel store the palette's
 * own hook reads, so titles, subtitles and icons come out of the same
 * composition the app runs: an agent with an observed task reads "Claude: fix
 * auth tests", a bare shell reads "Terminal". The source pane is always
 * present and always excluded, exactly as when a selection is sent from it.
 */

export const SOURCE_ID = "t-src";

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/dev/Projects/helios",
    name: "helios",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
  {
    id: "wt-oauth",
    worktreeId: "wt-oauth",
    path: "/Users/dev/Projects/helios-worktrees/oauth-device-flow",
    name: "oauth-device-flow",
    branch: "feature/oauth-device-flow",
    isCurrent: false,
  },
  {
    id: "wt-long",
    worktreeId: "wt-long",
    path: "/Users/dev/Projects/helios-worktrees/streaming-token-refresh-with-exponential-backoff",
    name: "streaming-token-refresh-with-exponential-backoff",
    branch: "feature/streaming-token-refresh-with-exponential-backoff",
    isCurrent: false,
  },
];

function pane(
  id: string,
  title: string,
  worktreeId: string,
  extra: Partial<PtyPanelData> = {}
): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    cwd: "/Users/dev/Projects/helios",
    cols: 120,
    rows: 40,
    worktreeId,
    projectId: "proj-helios",
    location: "grid",
    hasPty: true,
    ...extra,
  } as PtyPanelData;
}

function agent(
  id: string,
  agentId: string,
  base: string,
  task: string | undefined,
  worktreeId: string,
  extra: Partial<PtyPanelData> = {}
): PtyPanelData {
  return pane(id, base, worktreeId, {
    detectedAgentId: agentId,
    lastObservedTitle: task,
    agentState: "idle",
    ...extra,
  } as Partial<PtyPanelData>);
}

const SOURCE = agent(SOURCE_ID, "claude", "Claude", "rebase onto develop", "wt-main");

function mixed(worktreeFor: (i: number) => string): PtyPanelData[] {
  return [
    SOURCE,
    agent("t-1", "claude", "Claude", "fix auth token refresh tests", worktreeFor(0), {
      agentState: "working",
    }),
    agent(
      "t-2",
      "codex",
      "Codex",
      "port the forge token banner to the shared InlineStatusBanner primitive and pin its contract",
      worktreeFor(1),
      { agentState: "waiting" }
    ),
    agent("t-3", "claude", "Claude", "draft the release notes", worktreeFor(2), {
      isInputLocked: true,
    }),
    agent("t-4", "gemini", "Gemini", undefined, worktreeFor(1)),
    pane("t-5", "Terminal", worktreeFor(0)),
  ];
}

export interface SendToAgentFixture {
  panes: PtyPanelData[];
  worktrees: WorktreeSnapshot[];
  /** Panes closed after the palette opened, as when a target exits mid-pick. */
  closeAfterOpen?: string[];
}

const FIXTURES: Record<string, SendToAgentFixture> = {
  // Every target in one worktree: rows carry the agent only.
  mixed: { panes: mixed(() => "wt-main"), worktrees: WORKTREES },
  // Targets across three worktrees: rows carry the worktree too.
  worktrees: {
    panes: mixed((i) => WORKTREES[i % WORKTREES.length]!.id),
    worktrees: WORKTREES,
  },
  // Every target locked: nothing Enter could act on.
  "all-locked": {
    panes: [
      SOURCE,
      agent("t-1", "claude", "Claude", "fix auth token refresh tests", "wt-main", {
        isInputLocked: true,
      }),
      agent("t-2", "codex", "Codex", "write the migration", "wt-main", { isInputLocked: true }),
    ],
    worktrees: WORKTREES,
  },
  // The last target closed while the palette was open.
  empty: {
    panes: [SOURCE, pane("t-1", "Terminal", "wt-main")],
    worktrees: WORKTREES,
    closeAfterOpen: ["t-1"],
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

export function requireFixture(name: string): SendToAgentFixture {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`unknown send-to-agent fixture "${name}"`);
  return fixture;
}
