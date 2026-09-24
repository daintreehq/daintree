import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState, WorktreeState } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import { WorktreeHeader } from "../WorktreeCard/WorktreeHeader";
import {
  CHIP_LABELS,
  WorktreeStatusTick,
  type WorktreeStatusTickState,
} from "../WorktreeCard/WorktreeStatusTick";
import { computeChipState } from "../utils/computeChipState";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree card's status tick.
 *
 * Renders the REAL `WorktreeStatusTick` where `WorktreeCard` puts it — the
 * first child of the card root, wrapped in the same tooltip — beside the REAL
 * `WorktreeHeader`, inside the sidebar card's and the overview cell's real
 * chrome classes. The state is not picked here: each row's worktree fields go
 * through `computeChipState`, the same function the card calls, so `cleanup`
 * is a merged PR and `complete` is an issue with an open PR and a clean tree.
 * Those two need a live forge lookup in the full app, which is why this page
 * exists rather than a step in the Electron card harness.
 *
 * Query parameters:
 *   ?theme=<id>                         built-in theme id
 *   ?fixture=sidebar|collapsed|grid|specimen
 *   ?width=320                          sidebar card width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "sidebar";
const width = Number(params.get("width") ?? "320");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-sidebar)";
document.body.style.margin = "0";

const noop = () => {};
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const menu = new Proxy({}, { get: () => noop }) as WorktreeMenuActions;

interface RowFixture {
  id: string;
  branch: string;
  fields: Partial<WorktreeState>;
  sessions?: Partial<Record<AgentState, number>>;
  active?: boolean;
  /** No grip column: the main worktree, which cannot be reordered. */
  noGrip?: boolean;
}

const prRef = { providerId: "github", owner: "helios", repo: "dashboard", rawData: null };

const withPr = (state: "open" | "merged", number: number): Partial<WorktreeState> => ({
  linked: {
    providerId: "github",
    pr: {
      ref: { ...prRef, number },
      title: "Honour Retry-After on 429 responses",
      url: `https://github.com/helios/dashboard/pull/${number}`,
      state,
    },
  },
});

const clean: Partial<WorktreeState> = {
  worktreeChanges: {
    worktreeId: "",
    rootPath: "",
    changes: [],
    changedFileCount: 0,
    lastUpdated: 0,
  },
};

const ROWS: RowFixture[] = [
  {
    id: "waiting",
    branch: "feature/issue-4810-stream-upload-retry",
    fields: {
      ...clean,
      issueNumber: 4810,
      issueTitle: "Retry interrupted uploads from the last acknowledged chunk",
    },
    sessions: { waiting: 1, working: 0 },
  },
  {
    id: "cleanup",
    branch: "fix/issue-4821-retry-after",
    fields: {
      ...clean,
      ...withPr("merged", 4821),
      issueNumber: 4821,
      issueTitle: "Honour Retry-After on 429 responses",
    },
  },
  {
    id: "complete",
    branch: "feature/issue-4833-dark-mode-token-audit",
    fields: {
      ...clean,
      ...withPr("open", 4840),
      issueNumber: 4833,
      issueTitle: "Audit dark-mode tokens against the contrast gate",
    },
  },
  {
    id: "quiet",
    branch: "chore/bump-vite",
    fields: { ...clean },
  },
  {
    id: "waiting-active",
    branch: "feature/collapse-inspector-panel",
    fields: { ...clean, issueNumber: 4850, issueTitle: "Collapse the inspector below 960px" },
    sessions: { waiting: 2, idle: 1 },
    active: true,
  },
  {
    id: "complete-main",
    branch: "main",
    fields: {
      ...clean,
      ...withPr("open", 4861),
      issueNumber: 4861,
      issueTitle: "Release checklist",
    },
    noGrip: true,
  },
];

function worktreeFor(row: RowFixture): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id: `wt-${row.id}`,
    worktreeId: `wt-${row.id}`,
    path: `/Users/dev/helios-worktrees/${row.id}`,
    name: row.id,
    branch: row.branch,
    isCurrent: false,
    isMainWorktree: false,
    ...row.fields,
  } as unknown as WorktreeState;
}

function sessionStates(sessions: RowFixture["sessions"]) {
  const byState: Record<AgentState, number> = {
    working: sessions?.working ?? 0,
    waiting: sessions?.waiting ?? 0,
    directing: sessions?.directing ?? 0,
    idle: sessions?.idle ?? 0,
    completed: sessions?.completed ?? 0,
    exited: sessions?.exited ?? 0,
  };
  const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
  return { byState, total };
}

/**
 * The chip state exactly as `WorktreeCard` derives it. The two inputs the card
 * reads from `useWorktreeStatus` are recomputed here from the same fields,
 * since the hook needs the app's stores.
 */
function chipStateFor(worktree: WorktreeState, byState: Record<AgentState, number>) {
  const prState = worktree.linked?.pr?.state;
  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
  const isComplete =
    !!worktree.issueNumber &&
    !!worktree.linked?.pr &&
    prState !== "closed" &&
    prState !== "declined" &&
    !hasChanges &&
    worktree.worktreeChanges !== null;
  const lifecycleStage =
    prState === "merged" ? (worktree.issueNumber ? "ready-for-cleanup" : "merged") : null;
  return computeChipState({
    waitingTerminalCount: byState.waiting,
    lifecycleStage,
    isComplete,
    hasActiveAgent: byState.working > 0,
  });
}

function Tick({
  state,
  variant,
  collapsed,
}: {
  state: WorktreeStatusTickState;
  variant: "sidebar" | "grid";
  collapsed: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorktreeStatusTick state={state} variant={variant} collapsed={collapsed} />
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="text-xs">
        {CHIP_LABELS[state]}
      </TooltipContent>
    </Tooltip>
  );
}

function Card({
  row,
  variant,
  collapsed,
}: {
  row: RowFixture;
  variant: "sidebar" | "grid";
  collapsed: boolean;
}) {
  const worktree = worktreeFor(row);
  const { byState, total } = sessionStates(row.sessions);
  const chipState = chipStateFor(worktree, byState);
  const hasGrip = variant === "sidebar" && !row.noGrip;
  return (
    <div
      data-preview-row={row.id}
      data-chip-state={chipState ?? "none"}
      className={cn(
        "sidebar-worktree-card group/card relative isolate",
        variant === "grid" && "h-full rounded-lg",
        variant === "sidebar" && !row.active && "bg-transparent"
      )}
      data-variant={variant}
      data-active={row.active && variant === "sidebar" ? "true" : undefined}
      data-has-grip={hasGrip ? "true" : undefined}
      data-hoverable={!row.active && variant === "sidebar" ? "true" : undefined}
    >
      {chipState !== null && <Tick state={chipState} variant={variant} collapsed={collapsed} />}
      <div className={cn("relative z-10 flex", variant === "grid" && "h-full")}>
        {hasGrip && (
          // The card's real grip column: the tick sits over its top 4px, and
          // the plate it paints on hover runs straight up to the mark.
          <div
            data-worktree-row-drag-handle=""
            className="flex w-4 shrink-0 cursor-grab items-center justify-center text-text-muted opacity-0 hover:bg-overlay-soft hover:text-text-secondary hover:opacity-100 group-hover/card:opacity-100"
            aria-hidden="true"
          >
            <GripVertical className="h-3 w-3" />
          </div>
        )}
        <div
          className={cn(
            "min-w-0 flex-1",
            variant === "grid" && "flex h-full flex-col",
            hasGrip ? "ps-0" : "ps-4",
            "pe-4"
          )}
        >
          <div className={cn(collapsed ? "py-1" : "pt-2", variant === "grid" && "pr-5")}>
            <WorktreeHeader
              worktree={worktree}
              isActive={!!row.active}
              variant={variant}
              isMainWorktree={!!row.noGrip}
              isPinned={false}
              isCollapsed={collapsed}
              canCollapse={variant === "sidebar"}
              onToggleCollapse={noop}
              contentId={`worktree-body-${worktree.id}`}
              branchLabel={row.branch}
              sessionStates={byState}
              sessionTotal={total}
              badges={{}}
              gitStateIndicator={null}
              menu={menu}
            />
          </div>
          {!collapsed && (
            <div className="pb-2 pt-1 text-xs text-text-muted">
              {row.id === "quiet" ? "No changes" : "Clean · 2 commits ahead of develop"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The overview grid's cell chrome, copied from `OverviewGridCell`. */
function GridCell({ row, selected }: { row: RowFixture; selected?: boolean }) {
  return (
    <div
      className={cn(
        "relative h-full max-w-[480px] overflow-hidden rounded-lg border border-divider bg-overlay-subtle",
        selected && "bg-overlay-medium",
        selected &&
          "before:absolute before:bottom-3 before:start-0 before:top-6 before:z-10 before:w-[3px] before:rounded-full before:bg-selection-outline before:content-['']"
      )}
    >
      <Card row={row} variant="grid" collapsed={false} />
    </div>
  );
}

const STATES: WorktreeStatusTickState[] = ["waiting", "cleanup", "complete"];

/** Each state's mark on its own, both footprints, both variants' anchoring. */
function Specimen() {
  return (
    <div
      data-preview-card
      className="flex flex-col gap-3 bg-surface-sidebar p-3 text-2xs text-text-secondary"
    >
      {(["bar", "collapsed"] as const).map((form) => (
        <div key={form} className="flex items-center gap-6">
          <span className="w-16">{form}</span>
          {STATES.map((state) => (
            <span key={state} className="flex items-center gap-2">
              <span
                data-preview-specimen={`${form}-${state}`}
                className="relative block h-6 w-6 bg-surface-panel"
              >
                <WorktreeStatusTick state={state} collapsed={form === "collapsed"} />
              </span>
              <span>{state}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Body() {
  if (fixtureName === "specimen") return <Specimen />;
  if (fixtureName === "grid") {
    const cells = ROWS.filter((r) => r.id !== "complete-main");
    return (
      <div
        data-preview-card
        className="grid grid-cols-2 gap-3 bg-surface-canvas p-3"
        style={{ width: 720 }}
      >
        {cells.map((row, i) => (
          <GridCell key={row.id} row={row} selected={i === 1} />
        ))}
      </div>
    );
  }
  const collapsed = fixtureName === "collapsed";
  return (
    <div data-preview-card className="sidebar-root bg-surface-sidebar" style={{ width }}>
      {ROWS.map((row) => (
        <Card key={row.id} row={row} variant="sidebar" collapsed={collapsed} />
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={0}>
      <div data-preview-shell className="inline-block p-4">
        <Body />
      </div>
    </TooltipProvider>
  </StrictMode>
);
