import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState, WorktreeState } from "@shared/types";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import { WorktreeHeader } from "../WorktreeCard/WorktreeHeader";
import "@/index.css";

/**
 * Standalone visual-review harness for the dev-server indicator in the worktree
 * card header. Mounts the REAL `WorktreeHeader` in the sidebar card's chrome
 * and hands each row a dev-preview session through the header's real
 * `devServerSession` prop, so the indicator is judged beside the pin, external
 * and agent marks it shares the trailing group with.
 *
 * Query parameters:
 *   ?theme=<id>                    built-in theme id
 *   ?fixture=sidebar|collapsed     expanded or collapsed card headers
 *   ?width=320                     sidebar card width in CSS px
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
  session: Partial<DevPreviewSessionState> & Pick<DevPreviewSessionState, "status">;
  sessions?: Partial<Record<AgentState, number>>;
  pinned?: boolean;
  external?: boolean;
  active?: boolean;
}

const ROWS: RowFixture[] = [
  {
    id: "running",
    branch: "feature/stream-upload-retry",
    session: { status: "running", url: "http://localhost:5173/" },
  },
  {
    id: "running-agent",
    branch: "fix/queue-drain-ordering",
    session: { status: "running", url: "http://localhost:3000/" },
    sessions: { working: 1 },
    pinned: true,
  },
  {
    id: "starting",
    branch: "feature/dark-mode-token-audit",
    session: { status: "starting", predictedUrl: "http://localhost:5174/" },
  },
  {
    id: "installing",
    branch: "chore/bump-vite",
    session: { status: "installing" },
  },
  {
    id: "error-port",
    branch: "feature/collapse-inspector-panel",
    session: {
      status: "error",
      predictedUrl: "http://localhost:5173/",
      error: {
        type: "port-conflict",
        port: "5173",
        message: "Port 5173 is already in use. Stop the other server or use a different port.",
      },
    },
    external: true,
  },
  {
    id: "error-raw",
    branch: "spike/columnar-export",
    session: {
      status: "error",
      error: {
        type: "unknown",
        message:
          "Failed to start dev server: spawn /Users/dev/.nvm/versions/node/v22.23.2/bin/pnpm ENOENT (errno -2, syscall spawn, path /Users/dev/helios-worktrees/columnar-export)",
      },
    },
    active: true,
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
    isExternal: row.external === true,
    worktreeChanges: {
      worktreeId: "",
      rootPath: "",
      changes: [],
      changedFileCount: 0,
      lastUpdated: 0,
    },
  } as unknown as WorktreeState;
}

function sessionFor(row: RowFixture): DevPreviewSessionState {
  return {
    panelId: `panel-${row.id}`,
    projectId: "helios",
    worktreeId: `wt-${row.id}`,
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
    ...row.session,
  };
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

function Card({ row, collapsed }: { row: RowFixture; collapsed: boolean }) {
  const worktree = worktreeFor(row);
  const { byState, total } = sessionStates(row.sessions);
  return (
    <div
      data-preview-row={row.id}
      className={cn(
        "sidebar-worktree-card group/card relative isolate",
        !row.active && "bg-transparent"
      )}
      data-variant="sidebar"
      data-active={row.active ? "true" : undefined}
      data-hoverable={!row.active ? "true" : undefined}
    >
      <div className="relative z-10 flex">
        <div className="min-w-0 flex-1 ps-4 pe-4">
          <div className={collapsed ? "py-1" : "pt-2"}>
            <WorktreeHeader
              worktree={worktree}
              isActive={!!row.active}
              variant="sidebar"
              isMainWorktree={false}
              isPinned={!!row.pinned}
              isCollapsed={collapsed}
              canCollapse
              onToggleCollapse={noop}
              contentId={`worktree-body-${worktree.id}`}
              branchLabel={row.branch}
              sessionStates={byState}
              sessionTotal={total}
              badges={{}}
              gitStateIndicator={null}
              menu={menu}
              devServerSession={sessionFor(row)}
            />
          </div>
          {!collapsed && (
            <div className="pb-2 pt-1 text-xs text-text-muted">Clean · 2 commits ahead</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Body() {
  const collapsed = fixtureName === "collapsed";
  return (
    <div data-preview-card className="sidebar-root bg-surface-sidebar" style={{ width }}>
      {ROWS.map((row) => (
        <Card key={row.id} row={row} collapsed={collapsed} />
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
