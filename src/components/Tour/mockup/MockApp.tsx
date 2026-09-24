import type { ReactNode } from "react";
import {
  Bell,
  CircleDot,
  FolderTree,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquareMore,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  SquareMenu,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { DaintreeIcon, HollowCircle } from "@/components/icons";
import { STATE_COLORS, STATE_PRIORITY } from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import { MockAgentIcon, MockStateGlyph, type MockAgentId } from "./TourMock";

/**
 * The whole Daintree window, compressed onto the 640×360 tour canvas. Every
 * chapter plays inside the same frame, with each region roughly where it
 * really is — launchers and agents along the top, worktrees down the left,
 * panels in the grid, the dock underneath — so the map a user builds here is
 * the one they close the tour onto. Each chapter dims what it isn't about.
 *
 * Deliberately low fidelity: the real window is right behind the dialog.
 */
export const APP_LAYOUT = {
  width: 640,
  height: 360,
  toolbarHeight: 30,
  sidebarWidth: 156,
  dockHeight: 28,
  rightPanelWidth: 176,
} as const;

/** The grid's content box on the canvas (inside its 8px padding), with no side panel open. */
export const GRID_RECT = {
  x: APP_LAYOUT.sidebarWidth + 8,
  y: APP_LAYOUT.toolbarHeight + 8,
  width: APP_LAYOUT.width - APP_LAYOUT.sidebarWidth - 16,
  height: APP_LAYOUT.height - APP_LAYOUT.toolbarHeight - APP_LAYOUT.dockHeight - 16,
} as const;

/** Pinned agents in toolbar order. */
export const TOOLBAR_AGENTS: readonly MockAgentId[] = ["claude", "codex", "antigravity"];

/**
 * Canvas centres of the frame's controls — where the pointer goes to "click"
 * them. Measured from the render, not computed: after changing the frame's
 * layout, open tour-preview.html and run `__tourAnchors()` in the console to
 * re-measure, then update this table.
 */
export const ANCHOR = {
  launcher: { x: 51, y: 14 },
  "agent-claude": { x: 84, y: 14 },
  "agent-codex": { x: 106, y: 14 },
  "agent-antigravity": { x: 128, y: 14 },
  terminal: { x: 161, y: 14 },
  "file-browser": { x: 183, y: 14 },
  forge: { x: 440, y: 14 },
  "forge-issues": { x: 412, y: 14 },
  "copy-context": { x: 523, y: 14 },
  palette: { x: 545, y: 14 },
  assistant: { x: 600, y: 14 },
  portal: { x: 622, y: 14 },
  "sidebar-arm": { x: 119, y: 46 },
  "sidebar-plus": { x: 139, y: 46 },
  "dock-launcher": { x: 174, y: 347 },
} as const satisfies Record<string, { x: number; y: number }>;

export function toolbarAgentPoint(agent: MockAgentId) {
  return ANCHOR[`agent-${agent}`];
}
export const SIDEBAR_PLUS_POINT = ANCHOR["sidebar-plus"];
/** "Select terminals to arm" — the sidebar header's lightning bolt. */
export const SIDEBAR_ARM_POINT = ANCHOR["sidebar-arm"];
export const DOCK_WAITING_POINT = { x: APP_LAYOUT.width - 40, y: APP_LAYOUT.height - 14 } as const;

export type AppRegion = "toolbar" | "sidebar" | "grid" | "dock" | "right";

function recede(region: AppRegion, focus: readonly AppRegion[] | undefined) {
  return cn(
    "transition-opacity duration-200 ease-out",
    focus && !focus.includes(region) ? "opacity-35" : "opacity-100"
  );
}

function Divider() {
  return <span className="mx-1 h-3.5 w-px shrink-0 bg-border-default" />;
}

function ToolbarButton({
  children,
  className,
  anchor,
}: {
  children: ReactNode;
  className?: string;
  /** Names the control so scenes and the harness can locate it on the canvas. */
  anchor?: string;
}) {
  return (
    <span
      data-tour-anchor={anchor}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md text-text-secondary [&_svg]:size-3",
        className
      )}
    >
      {children}
    </span>
  );
}

export interface MockWorktree {
  name: string;
  /** For an issue worktree the real card leads with the issue's title, not the folder name. */
  issueTitle?: string;
  branch: string;
  selected?: boolean;
  /** Agent states, as the real card's session row of glyphs. */
  states?: readonly AgentState[];
  /** Change counts, e.g. "+94 −4". */
  changes?: string;
  /** A trailing control on the changes row, as the real card's review button. */
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function MockWorktreeCard({
  name,
  issueTitle,
  branch,
  selected,
  states,
  changes,
  action,
  className,
  children,
}: MockWorktree) {
  // The card shows one glyph — its most urgent session's — as the real card's
  // priority rule does, never one glyph per agent.
  const shown = states?.length ? STATE_PRIORITY.find((state) => states.includes(state)) : undefined;
  return (
    <div
      data-tour-anchor={`worktree-${name}`}
      className={cn(
        "relative flex flex-col gap-1 rounded-md border px-2 py-1.5 transition-[background-color,border-color] duration-150 ease-out",
        selected
          ? "border-border-default bg-overlay-selected"
          : "border-transparent bg-transparent",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {issueTitle ? (
          <CircleDot className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
        ) : (
          <GitBranch className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        <span className="truncate text-2xs font-medium text-text-primary">
          {issueTitle ?? name}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-[18px]">
        <span
          data-tour-anchor={`worktree-${name}-branch`}
          className="truncate text-3xs text-text-secondary"
        >
          {branch}
        </span>
        <span className="flex-1" />
        {changes && (
          <span className="shrink-0 text-3xs tabular-nums text-text-secondary">{changes}</span>
        )}
        {shown && (
          <span className="flex shrink-0 items-center [&>span]:size-2.5 [&_svg]:size-2.5 [&_.spinner-circle]:size-2.5">
            <MockStateGlyph state={shown} />
          </span>
        )}
        {action}
      </div>
      {children}
    </div>
  );
}

/** The dock's waiting pill, as the real one: glyph, word, count. */
export function MockWaitingPill({ count, className }: { count: number; className?: string }) {
  return (
    <span
      data-tour-anchor="dock-waiting"
      className={cn(
        "flex items-center gap-1 rounded-full border border-border-strong bg-surface-panel px-2 py-0.5",
        className
      )}
    >
      <HollowCircle className={cn("size-2.5", STATE_COLORS.waiting)} />
      <span className="text-3xs font-medium text-text-primary">Waiting</span>
      <span className="text-3xs tabular-nums text-text-secondary">{count}</span>
    </span>
  );
}

interface MockAppProps {
  /** Regions kept at full strength; the rest recede. Omit to show everything evenly. */
  focus?: readonly AppRegion[];
  worktrees: ReactNode;
  grid: ReactNode;
  /** Right-hand dock content, e.g. the waiting pill. */
  dock?: ReactNode;
  /** Branch of the selected worktree, shown in the toolbar's project pill. */
  branch?: string;
  /** Content of the right-hand side panel (the Assistant). Omit for none. */
  rightPanel?: ReactNode;
  /** Floats above the main area: dialogs, menus, the review surface. */
  overlay?: ReactNode;
  children?: ReactNode;
}

export function MockApp({
  focus,
  worktrees,
  grid,
  dock,
  branch = "main",
  rightPanel,
  overlay,
  children,
}: MockAppProps) {
  return (
    <div className="absolute inset-0 flex flex-col bg-surface-canvas">
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 border-b border-border-subtle bg-surface-toolbar px-2",
          recede("toolbar", focus)
        )}
        style={{ height: APP_LAYOUT.toolbarHeight }}
      >
        <ToolbarButton anchor="sidebar-toggle">
          <PanelLeft aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton anchor="launcher">
          <Plus aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <span data-tour-anchor="toolbar-agents" className="flex items-center gap-0.5">
          {TOOLBAR_AGENTS.map((agent) => (
            <ToolbarButton key={agent} anchor={`agent-${agent}`}>
              <MockAgentIcon agent={agent} className="size-3.5" />
            </ToolbarButton>
          ))}
        </span>
        <Divider />
        <ToolbarButton anchor="terminal">
          <SquareTerminal aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton anchor="file-browser">
          <FolderTree aria-hidden="true" />
        </ToolbarButton>
        <span className="flex-1" />
        <span
          data-tour-anchor="project"
          className="flex min-w-0 max-w-[180px] items-center gap-1.5 whitespace-nowrap rounded-md border border-border-subtle bg-surface-panel px-2 py-0.5"
        >
          <span className="text-3xs">🌿</span>
          <span className="shrink-0 text-3xs font-medium text-text-primary">shop-app</span>
          <span className="flex min-w-0 items-center gap-0.5 text-3xs text-text-secondary">
            <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{branch}</span>
          </span>
        </span>
        <span className="flex-1" />
        <span
          data-tour-anchor="forge"
          className="mr-0.5 flex items-center gap-1.5 rounded-md border border-border-subtle px-1.5 py-0.5 text-3xs tabular-nums text-text-secondary [&_svg]:size-2.5"
        >
          <span data-tour-anchor="forge-issues" className="flex items-center gap-0.5">
            <CircleDot aria-hidden="true" />
            12
          </span>
          <span data-tour-anchor="forge-prs" className="flex items-center gap-0.5">
            <GitPullRequest aria-hidden="true" />3
          </span>
          <span className="flex items-center gap-0.5">
            <GitCommitHorizontal aria-hidden="true" />
            24
          </span>
        </span>
        <ToolbarButton anchor="notifications">
          <Bell aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton anchor="copy-context">
          <Folders aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton anchor="palette">
          <SquareMenu aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton anchor="settings">
          <SlidersHorizontal aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton anchor="assistant">
          <DaintreeIcon className="size-3" />
        </ToolbarButton>
        <ToolbarButton anchor="portal">
          <MessageSquareMore aria-hidden="true" />
        </ToolbarButton>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex shrink-0 flex-col gap-1.5 border-r border-border-subtle bg-surface-sidebar",
            recede("sidebar", focus)
          )}
          style={{ width: APP_LAYOUT.sidebarWidth }}
        >
          <div className="flex h-7 shrink-0 items-center justify-between px-2.5 pt-1">
            <span className="text-2xs font-semibold text-text-primary">Worktrees</span>
            <span className="flex items-center gap-2 text-text-secondary">
              <Zap data-tour-anchor="sidebar-arm" className="size-3" aria-hidden="true" />
              <Plus data-tour-anchor="sidebar-plus" className="size-3" aria-hidden="true" />
            </span>
          </div>
          <div className="mx-2 flex h-4 shrink-0 items-center gap-1 rounded-sm border border-border-subtle px-1.5">
            <Search className="size-2.5 text-text-secondary" aria-hidden="true" />
            <span className="text-3xs text-text-placeholder">Search worktrees…</span>
          </div>
          <div data-tour-anchor="worktree-list" className="flex min-h-0 flex-col gap-0.5 px-1.5">
            {worktrees}
          </div>
        </div>

        {/* The dock belongs to the grid column: it runs from the sidebar's edge
            to the side panel, never under either. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={cn("relative min-h-0 flex-1 bg-surface-grid p-2", recede("grid", focus))}>
            {grid}
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-toolbar px-2",
              recede("dock", focus)
            )}
            style={{ height: APP_LAYOUT.dockHeight }}
          >
            <ToolbarButton anchor="dock-launcher">
              <Plus aria-hidden="true" />
            </ToolbarButton>
            <span className="flex-1" />
            {dock}
          </div>
        </div>

        {rightPanel && (
          <div
            className={cn(
              "flex shrink-0 flex-col border-l border-border-subtle bg-surface-sidebar",
              recede("right", focus)
            )}
            style={{ width: APP_LAYOUT.rightPanelWidth }}
          >
            {rightPanel}
          </div>
        )}
      </div>

      {overlay}
      {children}
    </div>
  );
}

/** A grid of panes with the real grid's gap, filling the grid region. */
export function MockGrid({
  columns,
  rows = 1,
  children,
  className,
}: {
  columns: number;
  rows?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("grid size-full gap-1.5", className)}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
