import type { Issue } from "@shared/types/forge";
import type { PtyPanelData } from "@shared/types/panel";
import type { StagingFileEntry } from "@shared/types";
import type { DiffChangeSetEntry } from "@shared/types/git";
import type { PendingCrash } from "@shared/types/ipc";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { TerminalRecipe } from "@/types";
import { DELETE_WORKTREE_ID, PREVIEW_ROOT } from "./checkboxFamilyBridge";

/** Fixture data for the checkbox-family harness. Realistic lengths, so truncation shows. */

export const ISSUE: Issue = {
  number: 11958,
  title: "Retry backoff ignores the server's Retry-After header",
  body: "",
  state: "open",
  rawState: "OPEN",
  url: "https://github.com/helios-labs/helios-dashboard/issues/11958",
  author: { login: "mira-okafor", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: Date.parse("2026-09-20T09:00:00Z"),
  updatedAt: Date.parse("2026-09-27T09:00:00Z"),
  rawData: {},
};

export const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: PREVIEW_ROOT,
    name: "helios-dashboard",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
  {
    id: DELETE_WORKTREE_ID,
    worktreeId: DELETE_WORKTREE_ID,
    path: DELETE_WORKTREE_ID,
    name: "feature-retry-backoff",
    branch: "feature/retry-backoff",
    isCurrent: false,
  },
  {
    id: "wt-12383",
    worktreeId: "wt-12383",
    path: "/Users/you/Code/helios-dashboard-worktrees/issue-12383",
    name: "issue-12383",
    branch: "bugfix/issue-12383-menu-rows-show-keyboard-focus",
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
    cwd: PREVIEW_ROOT,
    cols: 120,
    rows: 40,
    detectedAgentId: "claude",
    worktreeId,
    projectId: "proj-helios",
    location: "grid",
    agentState,
    hasPty: true,
    ...extra,
  } as PtyPanelData;
}

export const PANES: PtyPanelData[] = [
  pane("t-1", "claude · retry backoff", DELETE_WORKTREE_ID, "working"),
  pane("t-2", "codex · Retry-After header parsing and jitter", DELETE_WORKTREE_ID, "waiting", {
    waitingReason: "approval",
  }),
  pane("t-3", "zsh", DELETE_WORKTREE_ID, undefined, { detectedAgentId: undefined }),
  pane("t-4", "claude · menu rows focus ring", "wt-12383", "working"),
  pane("t-5", "gemini · worktree card PR number", "wt-12383", "idle"),
  pane("t-6", "claude · release notes", "wt-main", "working"),
  pane("t-7", "codex · import budget ratchet", "wt-main", "idle"),
];

export const RECIPES: TerminalRecipe[] = [
  {
    id: "r-review",
    name: "Review pair",
    terminals: [{ type: "claude" }, { type: "codex" }],
    createdAt: 1,
    autoAssign: "prompt",
  },
  {
    id: "r-solo",
    name: "Solo Claude",
    terminals: [{ type: "claude" }],
    createdAt: 1,
    autoAssign: "prompt",
  },
  {
    id: "r-dev",
    name: "Claude with dev server",
    terminals: [{ type: "claude" }, { type: "dev-preview" }],
    createdAt: 1,
    autoAssign: "never",
  },
];

export const STAGE_FILES: StagingFileEntry[] = [
  { path: "src/net/retryBackoff.ts", status: "modified", insertions: 24, deletions: 6 },
  { path: "src/net/__tests__/retryBackoff.test.ts", status: "added", insertions: 41, deletions: 0 },
  { path: "docs/networking/retries.md", status: "modified", insertions: 3, deletions: 1 },
];

export const DIFF_FILES: DiffChangeSetEntry[] = [
  {
    path: "src/net/retryBackoff.ts",
    status: "modified",
    insertions: 24,
    deletions: 6,
    viewedKey: "unstaged:src/net/retryBackoff.ts",
  },
  {
    path: "src/net/__tests__/retryBackoff.test.ts",
    status: "added",
    insertions: 41,
    deletions: 0,
    viewedKey: "unstaged:src/net/__tests__/retryBackoff.test.ts",
  },
  {
    path: "src/net/headers.ts",
    status: "modified",
    insertions: 9,
    deletions: 2,
    viewedKey: "unstaged:src/net/headers.ts",
  },
  {
    path: "docs/networking/retries.md",
    status: "modified",
    insertions: 3,
    deletions: 1,
    viewedKey: "unstaged:docs/networking/retries.md",
  },
];

export const DIFF_VIEWED_KEYS = [
  "unstaged:src/net/retryBackoff.ts",
  "unstaged:docs/networking/retries.md",
];

export const CRASH: PendingCrash = {
  logPath: "/Users/you/Library/Logs/Daintree/crash-2026-09-28.json",
  hasBackup: true,
  backupTimestamp: Date.parse("2026-09-28T09:40:00Z"),
  crashCount: 1,
  entry: {
    id: "crash-preview",
    timestamp: Date.parse("2026-09-28T09:42:00Z"),
    appVersion: "0.14.0",
    platform: "darwin",
    osVersion: "25.4.0",
    arch: "arm64",
    errorMessage: "Renderer process gone (oom)",
  },
  panels: [
    {
      id: "p-1",
      kind: "agent",
      title: "claude · retry backoff",
      cwd: DELETE_WORKTREE_ID,
      location: "grid",
      isSuspect: false,
      agentState: "working",
    },
    {
      id: "p-2",
      kind: "terminal",
      title: "zsh",
      cwd: PREVIEW_ROOT,
      location: "grid",
      isSuspect: false,
    },
    {
      id: "p-3",
      kind: "browser",
      title: "localhost:5173 — Helios dashboard",
      location: "dock",
      isSuspect: true,
      suspectReason: "crash-window",
    },
    {
      id: "p-4",
      kind: "dev-preview",
      title: "Dev server",
      cwd: PREVIEW_ROOT,
      location: "dock",
      isSuspect: false,
    },
  ],
};
