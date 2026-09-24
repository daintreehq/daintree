import "@/components/Panel/__preview__/installShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentState, WorktreeSnapshot, WorktreeState } from "@shared/types";
import type { CIStatusState } from "@shared/types/forge";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeOverviewModal } from "../WorktreeOverviewModal";
import { WorktreeCard } from "../WorktreeCard";
import "@/index.css";

const { LazyMotion, domAnimation } = await import("framer-motion");

/**
 * Standalone visual-review harness for the worktree overview.
 *
 * Mounts the REAL `WorktreeOverviewModal` over a stand-in app canvas, fed from
 * the same two seams the app uses: the per-view worktree store (snapshots) and
 * the panel store (agent terminals). No Electron, no PTYs — a fleet in every
 * state the surface has to tell apart, on demand.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fleet=busy|few|single|empty  which worktree set
 *   ?scene=overview|sidebar       the modal, or the same worktrees as sidebar cards
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fleetName = params.get("fleet") ?? "busy";
const scene = params.get("scene") === "sidebar" ? "sidebar" : "overview";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const NOW = Date.now();
const MIN = 60_000;
const ROOT = "/Users/dev/daintree";

interface SessionSeed {
  agentId?: string;
  state?: AgentState;
  title?: string;
  location?: "grid" | "dock";
}

interface WorktreeSeed {
  id: string;
  branch: string;
  isMain?: boolean;
  isCurrent?: boolean;
  issue?: { number: number; title: string };
  pr?: { number: number; state: "open" | "merged"; ci?: CIStatusState };
  files?: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "conflicted";
    ins: number;
    del: number;
  }>;
  commit: string;
  commitAgoMin: number;
  activityAgoMin: number;
  ahead?: number;
  behind?: number;
  aiNote?: string;
  sessions?: SessionSeed[];
}

const BUSY: WorktreeSeed[] = [
  {
    id: "wt-main",
    branch: "develop",
    isMain: true,
    commit: "Merge pull request #12701 from daintreehq/design/web-chat-sidebar",
    commitAgoMin: 125,
    activityAgoMin: 125,
  },
  {
    id: "wt-handback",
    branch: "feature/issue-12486-handback-marker",
    isCurrent: true,
    issue: { number: 12486, title: "Emit a DAINTREE-DONE marker when an agent hands work back" },
    pr: { number: 12702, state: "open", ci: "pending" },
    files: [
      { path: "src/services/agent/handback.ts", status: "modified", ins: 212, del: 40 },
      { path: "src/services/agent/__tests__/handback.test.ts", status: "added", ins: 140, del: 0 },
      { path: "shared/types/agent.ts", status: "modified", ins: 22, del: 8 },
      { path: "docs/architecture/handback.md", status: "modified", ins: 38, del: 40 },
    ],
    commit: "feat(agent): parse the handback marker from PTY output",
    commitAgoMin: 14,
    activityAgoMin: 0.3,
    ahead: 3,
    aiNote: "Wiring the marker into AgentStateService; tests next",
    sessions: [
      { agentId: "claude", state: "working", title: "Wire the handback marker into the FSM" },
      { title: "npm test -- handback", location: "dock" },
    ],
  },
  {
    id: "wt-dock-drop",
    branch: "bugfix/issue-12593-dock-drop",
    issue: { number: 12593, title: "Dropping a folder on the Dock icon opens a second window" },
    files: [
      { path: "electron/window/openRouting.ts", status: "modified", ins: 12, del: 3 },
      { path: "electron/window/__tests__/openRouting.test.ts", status: "modified", ins: 2, del: 0 },
    ],
    commit: "fix(window): route dock drops to the focused window",
    commitAgoMin: 38,
    activityAgoMin: 4,
    ahead: 1,
    sessions: [{ agentId: "codex", state: "waiting", title: "Approve running the e2e spec?" }],
  },
  {
    id: "wt-codex-scroll",
    branch: "fix/issue-12601-codex-scroll",
    issue: { number: 12601, title: "Codex resize reflow clears scrollback" },
    files: [
      {
        path: "src/components/Terminal/useResizeReflow.ts",
        status: "conflicted",
        ins: 30,
        del: 11,
      },
      { path: "src/components/Terminal/XtermAdapter.tsx", status: "modified", ins: 9, del: 2 },
    ],
    commit: "wip: hold the viewport across ESC[3J",
    commitAgoMin: 61,
    activityAgoMin: 1,
    behind: 4,
    sessions: [
      { agentId: "gemini", state: "working", title: "Reproduce the reflow on a 40-row pane" },
      {
        agentId: "claude",
        state: "waiting",
        title:
          "Which merge side should win in useResizeReflow.ts — keep the viewport pin, or the scrollback replay from ESC[3J?",
      },
    ],
  },
  {
    id: "wt-fleet-ribbon",
    branch: "feature/issue-12440-fleet-ribbon",
    issue: { number: 12440, title: "Fleet ribbon shows armed agents across worktrees" },
    pr: { number: 12655, state: "open", ci: "success" },
    commit: "test(fleet): pin the ribbon's overflow rule",
    commitAgoMin: 190,
    activityAgoMin: 170,
    sessions: [{ agentId: "claude", state: "completed", title: "Fleet ribbon overflow" }],
  },
  {
    id: "wt-electron",
    branch: "chore/issue-12388-electron-42",
    issue: { number: 12388, title: "Bump Electron to 42" },
    pr: { number: 12390, state: "merged", ci: "success" },
    commit: "chore(deps): electron 42.0.1",
    commitAgoMin: 60 * 26,
    activityAgoMin: 60 * 26,
  },
  {
    id: "wt-overview",
    branch: "design/worktree-overview",
    files: [
      {
        path: "src/components/Worktree/WorktreeOverviewModal.tsx",
        status: "modified",
        ins: 305,
        del: 190,
      },
      {
        path: "src/components/Worktree/WorktreeOverviewRow.tsx",
        status: "added",
        ins: 240,
        del: 0,
      },
      {
        path: "src/components/Worktree/__preview__/overview.tsx",
        status: "added",
        ins: 180,
        del: 0,
      },
    ],
    commit: "Merge pull request #12701 from daintreehq/design/web-chat-sidebar",
    commitAgoMin: 125,
    activityAgoMin: 0.5,
    sessions: [{ agentId: "claude", state: "idle", title: "Worktree overview redesign" }],
  },
  {
    id: "wt-sqlite",
    branch: "spike/sqlite-wal-checkpoint",
    files: [{ path: "electron/services/db/wal.ts", status: "modified", ins: 18, del: 6 }],
    commit: "spike: checkpoint WAL on idle",
    commitAgoMin: 60 * 24 * 9,
    activityAgoMin: 60 * 24 * 9,
    behind: 212,
  },
  {
    id: "wt-help-queue",
    branch: "docs/help-rolling-queue",
    pr: { number: 12690, state: "open", ci: "failure" },
    commit: "docs(help): describe the rolling queue",
    commitAgoMin: 60 * 5,
    activityAgoMin: 60 * 5,
    ahead: 1,
  },
];

const FLEETS: Record<string, WorktreeSeed[]> = {
  busy: BUSY,
  // The shape the reported screenshot had: main plus two linked worktrees.
  few: [BUSY[0]!, BUSY[8]!, BUSY[6]!],
  single: [BUSY[0]!],
  empty: [],
};

const seeds = FLEETS[fleetName] ?? BUSY;

function snapshot(seed: WorktreeSeed): WorktreeSnapshot {
  const changes = (seed.files ?? []).map((f) => ({
    path: f.path,
    status: f.status,
    insertions: f.ins,
    deletions: f.del,
  }));
  const name = seed.isMain ? "daintree" : seed.branch.split("/").pop()!;
  const path = seed.isMain ? ROOT : `${ROOT}-worktrees/${name}`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture: only the fields the overview reads
  return {
    id: seed.id,
    worktreeId: seed.id,
    path,
    name,
    branch: seed.branch,
    isCurrent: !!seed.isCurrent,
    isMainWorktree: !!seed.isMain,
    issueNumber: seed.issue?.number,
    issueTitle: seed.issue?.title,
    aiNote: seed.aiNote,
    aiNoteTimestamp: seed.aiNote ? NOW - 2 * MIN : undefined,
    aheadCount: seed.ahead ?? 0,
    behindCount: seed.behind ?? 0,
    baseBranchName: seed.isMain ? undefined : "develop",
    lastActivityTimestamp: NOW - seed.activityAgoMin * MIN,
    createdAt: NOW - 60 * 24 * MIN,
    linked: seed.pr
      ? {
          providerId: "github",
          pr: {
            ref: {
              providerId: "github",
              owner: "daintreehq",
              repo: "daintree",
              number: seed.pr.number,
              rawData: null,
            },
            url: `https://github.com/daintreehq/daintree/pull/${seed.pr.number}`,
            state: seed.pr.state,
            ciStatus: seed.pr.ci
              ? {
                  state: seed.pr.ci,
                  total: 4,
                  passed: seed.pr.ci === "success" ? 4 : 2,
                  failed: seed.pr.ci === "failure" ? 2 : 0,
                  pending: seed.pr.ci === "pending" ? 2 : 0,
                }
              : undefined,
          },
          ...(seed.issue
            ? {
                issue: {
                  ref: {
                    providerId: "github",
                    owner: "daintreehq",
                    repo: "daintree",
                    number: seed.issue.number,
                    rawData: null,
                  },
                  title: seed.issue.title,
                },
              }
            : {}),
        }
      : null,
    worktreeChanges: {
      worktreeId: seed.id,
      rootPath: path,
      changes,
      changedFileCount: changes.length,
      insertions: changes.reduce((n, c) => n + c.insertions, 0),
      deletions: changes.reduce((n, c) => n + c.deletions, 0),
      lastCommitMessage: seed.commit,
      lastCommitTimestampMs: NOW - seed.commitAgoMin * MIN,
      tracking: seed.isMain ? "origin/develop" : `origin/${seed.branch}`,
    },
  } as unknown as WorktreeSnapshot;
}

const snapshots = seeds.map(snapshot);

function seedPanels(): void {
  const rows: Record<string, PtyPanelData> = {};
  const byWorktree: Record<string, string[]> = {};
  for (const seed of seeds) {
    (seed.sessions ?? []).forEach((s, i) => {
      const id = `${seed.id}-s${i}`;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
      rows[id] = {
        id,
        kind: "terminal",
        title: s.agentId ? (s.title ?? s.agentId) : (s.title ?? "Terminal"),
        location: s.location ?? "grid",
        cwd: ROOT,
        cols: 120,
        rows: 40,
        worktreeId: seed.id,
        launchAgentId: s.agentId,
        detectedAgentId: s.agentId,
        agentState: s.state,
        lastObservedTitle: s.agentId ? s.title : undefined,
        lastStateChange: NOW - 3 * MIN,
        activityStatus: s.agentId ? undefined : "working",
        lastCommand: s.agentId ? undefined : s.title,
      } as PtyPanelData;
      (byWorktree[seed.id] ??= []).push(id);
    });
  }
  usePanelStore.setState({
    panelsById: rows,
    panelIds: Object.keys(rows),
    panelIdsByWorktreeId: byWorktree,
  } as Partial<ReturnType<typeof usePanelStore.getState>>);
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  useWorktreeFilterStore.setState({ hideMainWorktree: false });
}

seedPanels();

function SeedWorktrees({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({
      worktrees: new Map(snapshots.map((s) => [s.id, s])),
      isLoading: false,
      isInitialized: true,
    });
    return true;
  });
  return ready ? children : null;
}

const noop = () => {};

function toState(s: WorktreeSnapshot): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the modal's own prop shape
  return {
    ...s,
    worktreeChanges: s.worktreeChanges ?? null,
    lastActivityTimestamp: s.lastActivityTimestamp ?? null,
  } as unknown as WorktreeState;
}

const ACTIVE_ID = seeds.find((s) => s.isCurrent)?.id ?? seeds[0]?.id ?? null;

function OverviewScene() {
  return (
    <div data-preview-shell className="h-screen w-screen">
      <WorktreeOverviewModal
        isOpen
        onClose={noop}
        worktrees={snapshots.map(toState)}
        activeWorktreeId={ACTIVE_ID}
        onSelectWorktree={noop}
      />
    </div>
  );
}

/** The same worktrees as the sidebar draws them, so the two can be judged as one family. */
function SidebarScene() {
  return (
    <div data-preview-shell data-preview-sidebar className="w-[340px] bg-surface-sidebar">
      {snapshots.map((s) => (
        <WorktreeCard
          key={s.id}
          worktree={toState(s)}
          isActive={s.id === ACTIVE_ID}
          isFocused={false}
          onSelect={noop}
          onOpenEditor={noop}
        />
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <DndContext>
          <WorktreeStoreProvider>
            <SeedWorktrees>
              {scene === "sidebar" ? <SidebarScene /> : <OverviewScene />}
            </SeedWorktrees>
          </WorktreeStoreProvider>
        </DndContext>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
