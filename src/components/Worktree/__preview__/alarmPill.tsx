import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentState, WorktreeState } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import { WorktreeHeader } from "../WorktreeCard/WorktreeHeader";
import { CollapsedAlarmPill } from "../WorktreeCard/CollapsedAlarmPill";
import "@/index.css";

/**
 * Standalone visual-review harness for the collapsed-row alarm pill.
 *
 * Renders the REAL `WorktreeHeader` in its collapsed form, inside the sidebar
 * card's real chrome classes, so the pill is judged beside the branch label,
 * the session indicators and the row toolbar it has to share one line with.
 * The alarm is derived by the header itself from the worktree fields below —
 * `computeAlarmTier` and `formatAlarmDetail` run exactly as they do in the app.
 *
 * Query parameters:
 *   ?theme=<id>        built-in theme id
 *   ?fixture=list|matrix
 *   ?width=320         card width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "list";
const width = Number(params.get("width") ?? "320");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-sidebar)";
document.body.style.margin = "0";

const noop = () => {};
// Every menu action is a no-op: the pill never opens the menu, and the toolbar
// only needs the callbacks to exist.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const menu = new Proxy({}, { get: () => noop }) as WorktreeMenuActions;

interface RowFixture {
  id: string;
  branch: string;
  fields: Partial<WorktreeState>;
  sessions?: Partial<Record<AgentState, number>>;
  active?: boolean;
}

const pr = (state: "failure" | "success", failed: number, total: number) => ({
  linked: {
    providerId: "github",
    pr: {
      number: 4821,
      title: "Honour Retry-After on 429 responses",
      url: "https://github.com/helios/dashboard/pull/4821",
      state: "open",
      ciStatus: { state, failed, total },
    },
  },
});

const ROWS: RowFixture[] = [
  {
    id: "quiet",
    branch: "feature/dark-mode-token-audit",
    fields: {},
  },
  {
    id: "behind",
    branch: "fix/retry-backoff-jitter",
    fields: {
      behindCount: 3,
      aheadCount: 1,
      baseBranchName: "develop",
      baseCompareRef: "origin/develop",
      baseBehindCount: 3,
      baseAheadCount: 1,
      baseMatchesUpstream: true,
    },
  },
  {
    id: "auth-failed",
    branch: "feature/stream-upload-retry",
    fields: { fetchAuthFailed: true, matchedForgeProviderId: "github" },
  },
  {
    id: "ci-failed",
    branch: "feature/collapse-inspector-panel",
    fields: pr("failure", 3, 12),
  },
  {
    id: "behind-sessions",
    branch: "chore/bump-vite",
    fields: { baseBranchName: "develop", baseBehindCount: 14 },
    sessions: { waiting: 1, working: 2 },
  },
  {
    id: "ci-failed-sessions-long",
    branch: "feature/collapse-the-inspector-panel-when-the-window-narrows-below-the-breakpoint",
    fields: pr("failure", 1, 4),
    sessions: { waiting: 1 },
  },
  {
    id: "auth-failed-active",
    branch: "fix/forge-token-refresh",
    fields: { fetchAuthFailed: true, matchedForgeProviderId: "github" },
    sessions: { working: 1 },
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

/** The sidebar card's own chrome, collapsed: grip gutter, content column, `py-1`. */
function Row({ row }: { row: RowFixture }) {
  const worktree = worktreeFor(row);
  const { byState, total } = sessionStates(row.sessions);
  return (
    <div
      data-preview-row={row.id}
      className="sidebar-worktree-card group/card relative flex"
      data-variant="sidebar"
      data-active={row.active ? "true" : undefined}
      data-hoverable={row.active ? undefined : "true"}
    >
      <div className="w-4 shrink-0" aria-hidden="true" />
      <div className="relative z-10 min-w-0 flex-1 pe-4">
        <div className="py-1">
          <WorktreeHeader
            worktree={worktree}
            isActive={!!row.active}
            variant="sidebar"
            isMainWorktree={false}
            isPinned={false}
            isCollapsed
            canCollapse
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
      </div>
    </div>
  );
}

const KINDS = [
  { kind: "behind", label: "Behind" },
  { kind: "auth-failed", label: "Auth failed" },
  { kind: "ci-failed", label: "CI failed" },
] as const;

/** Every kind in every tone, in isolation, so tone and shape can be read apart. */
function Matrix() {
  const tones = ["warning", "error"] as const;
  return (
    <div className="flex flex-col gap-2 p-3 text-2xs text-text-secondary">
      {tones.map((tone) => (
        <div key={tone} className="flex items-center gap-4">
          <span className="w-14">{tone}</span>
          {KINDS.map(({ kind, label }) => {
            const alarm: AlarmDescriptor = { tier: 1, kind, label, tone };
            return (
              <span key={kind} className="flex items-center gap-1.5">
                <CollapsedAlarmPill alarm={alarm} />
                <span>{kind}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={0}>
      <div data-preview-shell className="inline-block p-4">
        <div
          data-preview-card
          className="sidebar-root bg-surface-sidebar"
          style={{ width: fixtureName === "matrix" ? undefined : width }}
        >
          {fixtureName === "matrix" ? (
            <Matrix />
          ) : (
            ROWS.map((row) => <Row key={row.id} row={row} />)
          )}
        </div>
      </div>
    </TooltipProvider>
  </StrictMode>
);
