import "@/components/Panel/__preview__/installShims";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState, WorktreeState } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton, SkeletonBone, SkeletonHint, SkeletonText } from "@/components/ui/Skeleton";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { WorktreeCardPlaceholder } from "@/components/Sidebar/WorktreeCardPlaceholder";
import { WorktreeHeader } from "@/components/Worktree/WorktreeCard/WorktreeHeader";
import type { WorktreeMenuActions } from "@/components/Worktree/WorktreeMenuItems";
import type { PendingCreation } from "@/store/worktreeStore";
import "@/index.css";

/**
 * Standalone visual-review harness for the loading-skeleton family.
 *
 * A skeleton is on screen for a second at a time, so nobody ever looks at one
 * long enough to notice it is invisible, the wrong shape, or pulsing into the
 * background. This mounts the REAL primitives from `ui/Skeleton.tsx`, the REAL
 * `BrowserPaneSkeleton`, and the REAL `WorktreeCardPlaceholder` between real
 * collapsed `WorktreeHeader` rows, against the real theme tokens and `index.css`.
 * The capture spec pauses every animation on a chosen frame, so a pulse trough
 * can be photographed as deliberately as its peak.
 *
 * Query parameters:
 *   ?theme=<id>      built-in theme id
 *   ?fixture=<name>  primitives | hint | browser-pane | browser-pane-hint |
 *                    worktree-creating | worktree-error
 *   ?fast=1          scales timers down 100x so the long-wait hint reaches its
 *                    later phases in a capture rather than in 20 real seconds
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = params.get("fixture") ?? "primitives";

if (params.get("fast") === "1") {
  const realSetTimeout = window.setTimeout.bind(window);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- harness timer shim
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(handler, (ms ?? 0) / 100, ...args)) as typeof window.setTimeout;
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => {};

/** Harness decoration: names the surface a column sits on. Not product UI. */
function SurfaceLabel({ children }: { children: ReactNode }) {
  return (
    <div
      data-harness-decoration
      className="mb-3 font-mono text-xs uppercase tracking-wide text-text-secondary"
    >
      {children}
    </div>
  );
}

const SURFACES = [
  { id: "canvas", className: "bg-surface-canvas" },
  { id: "sidebar", className: "bg-surface-sidebar" },
  { id: "panel", className: "bg-surface-panel" },
  { id: "elevated", className: "bg-surface-panel-elevated" },
] as const;

function PrimitivesColumn({ surface }: { surface: (typeof SURFACES)[number] }) {
  return (
    <div
      data-surface={surface.id}
      className={`w-[260px] shrink-0 border-r border-divider p-4 ${surface.className}`}
    >
      <SurfaceLabel>{surface.id}</SurfaceLabel>
      <Skeleton label={`Loading ${surface.id} example`} className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <SkeletonBone className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <SkeletonBone className="h-3.5 w-3/4" />
            <SkeletonBone className="h-3 w-1/2" />
          </div>
        </div>
        <SkeletonText lines={3} />
        <SkeletonBone className="h-20 w-full" />
        <SkeletonBone shimmer className="h-8 w-full" />
      </Skeleton>
    </div>
  );
}

function Primitives() {
  return (
    <div data-fixture="primitives" className="inline-flex border border-divider">
      {SURFACES.map((surface) => (
        <PrimitivesColumn key={surface.id} surface={surface} />
      ))}
    </div>
  );
}

const HINTS = [
  { id: "first", props: { firstThreshold: 0, secondThreshold: 1e9 } },
  { id: "second", props: { firstThreshold: 0, secondThreshold: 0, actionThreshold: 1e9 } },
  {
    id: "message",
    props: { firstThreshold: 0, secondThreshold: 1e9, message: "Fetching 3 of 12 files…" },
  },
  {
    id: "cancel",
    props: { firstThreshold: 0, secondThreshold: 1e9, onCancel: noop },
  },
  {
    id: "action",
    props: {
      firstThreshold: 0,
      secondThreshold: 0,
      actionThreshold: 0,
      onCancel: noop,
      onRetry: noop,
    },
  },
] as const;

function Hints() {
  return (
    <div data-fixture="hint" className="w-[520px] border border-divider bg-surface-panel">
      {HINTS.map((hint) => (
        <div key={hint.id} className="border-b border-divider p-4 last:border-b-0">
          <SurfaceLabel>{hint.id}</SurfaceLabel>
          <Skeleton label="Loading example" className="mb-3">
            <SkeletonText lines={2} />
          </Skeleton>
          <SkeletonHint data-hint={hint.id} {...hint.props} />
        </div>
      ))}
    </div>
  );
}

function BrowserPaneFrame() {
  return (
    <div
      data-fixture={fixture}
      className="h-[420px] w-[720px] overflow-hidden rounded-[var(--radius-lg)] border border-divider bg-surface-panel"
    >
      <BrowserPaneSkeleton />
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const menu = new Proxy({}, { get: () => noop }) as WorktreeMenuActions;

const EMPTY_SESSIONS: Record<AgentState, number> = {
  working: 0,
  waiting: 0,
  directing: 0,
  idle: 0,
  completed: 0,
  exited: 0,
};

/** A real collapsed sidebar row, so the placeholder is judged beside what it becomes. */
function RealRow({
  branch,
  sessions,
}: {
  branch: string;
  sessions?: Partial<typeof EMPTY_SESSIONS>;
}) {
  const byState = { ...EMPTY_SESSIONS, ...sessions };
  const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  const worktree = {
    id: `wt-${branch}`,
    worktreeId: `wt-${branch}`,
    path: `/Users/dev/helios-worktrees/${branch}`,
    name: branch,
    branch,
    isCurrent: false,
    isMainWorktree: false,
  } as unknown as WorktreeState;
  return (
    <div
      className="sidebar-worktree-card group/card relative flex border-b border-divider"
      data-variant="sidebar"
      data-hoverable="true"
    >
      <div className="w-4 shrink-0" aria-hidden="true" />
      <div className="relative z-10 min-w-0 flex-1 pe-4">
        <div className="py-1">
          <WorktreeHeader
            worktree={worktree}
            isActive={false}
            variant="sidebar"
            isMainWorktree={false}
            isPinned={false}
            isCollapsed
            isKeyboardFocused={false}
            canCollapse
            onToggleCollapse={noop}
            contentId={`worktree-body-${worktree.id}`}
            branchLabel={branch}
            sessionStates={byState}
            sessionTotal={total}
            badges={{}}
            gitStateIndicator={null}
            menu={menu}
          />
        </div>
      </div>
    </div>
  );
}

const CREATING: PendingCreation = {
  path: "/Users/dev/helios-worktrees/feature-stream-upload-retry",
  branch: "feature/stream-upload-retry",
  startedAt: 0,
  status: "creating",
};

const FAILED: PendingCreation = {
  path: "/Users/dev/helios-worktrees/feature-collapse-inspector",
  branch: "feature/collapse-the-inspector-panel-when-the-window-narrows",
  startedAt: 0,
  status: "error",
  error:
    "fatal: a branch named 'feature/collapse-the-inspector-panel-when-the-window-narrows' already exists",
};

function WorktreeList({ pending }: { pending: PendingCreation }) {
  return (
    <div data-fixture={fixture} className="w-[320px] border border-divider bg-surface-sidebar">
      <RealRow branch="fix/retry-backoff-jitter" sessions={{ working: 1 }} />
      <WorktreeCardPlaceholder pendingCreation={pending} onRetry={noop} onDismiss={noop} />
      <RealRow branch="chore/bump-vite" />
      <RealRow branch="feature/dark-mode-token-audit" sessions={{ waiting: 1 }} />
    </div>
  );
}

function Fixture() {
  switch (fixture) {
    case "hint":
      return <Hints />;
    case "browser-pane":
    case "browser-pane-hint":
      return <BrowserPaneFrame />;
    case "worktree-creating":
      return <WorktreeList pending={CREATING} />;
    case "worktree-error":
      return <WorktreeList pending={FAILED} />;
    default:
      return <Primitives />;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div className="inline-block p-6">
        <Fixture />
      </div>
    </TooltipProvider>
  </StrictMode>
);
