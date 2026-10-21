import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { BRANCH_TYPES } from "@shared/config/branchPrefixes";
import type { WorktreeState } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMainWorktreeOnStandardBranch } from "@/lib/worktreeHeadline";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import { WorktreeHeader } from "../WorktreeCard/WorktreeHeader";
import { BranchLabel } from "../BranchLabel";
import "@/index.css";

/**
 * Standalone visual-review harness for the branch label every worktree card
 * draws: the type glyph, the branch with its prefix cut, and the tooltip that
 * gives the full name back.
 *
 * `cards` mounts the REAL `WorktreeHeader` in the sidebar card's real chrome, so
 * the label is judged where it lives: as a headline, and on the meta line under
 * an issue title.
 * `glyphs` lays out every branch type and agent namespace at the label's real
 * size, so the glyph set can be judged as a set.
 *
 * Query parameters:
 *   ?theme=<id>               built-in theme id
 *   ?fixture=cards|glyphs
 *   ?width=320                sidebar card width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "cards";
const width = Number(params.get("width") ?? "320");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-sidebar)";
document.body.style.margin = "0";

const noop = () => {};
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const menu = new Proxy({}, { get: () => noop }) as WorktreeMenuActions;

interface CardFixture {
  id: string;
  branch: string;
  fields?: Partial<WorktreeState>;
  active?: boolean;
  muted?: boolean;
  main?: boolean;
}

const clean: Partial<WorktreeState> = {
  worktreeChanges: {
    worktreeId: "",
    rootPath: "",
    changes: [],
    changedFileCount: 0,
    lastUpdated: 0,
  },
};

const CARDS: CardFixture[] = [
  { id: "main", branch: "release/2.4", main: true },
  { id: "feature", branch: "feature/login-retry", active: true },
  { id: "alias", branch: "fix/upload-backoff" },
  {
    id: "titled",
    branch: "feature/issue-4810-stream-upload-retry",
    fields: {
      issueNumber: 4810,
      issueTitle: "Retry interrupted uploads from the last acknowledged chunk",
    },
  },
  { id: "agent", branch: "claude/tidy-imports" },
  { id: "agent-typed", branch: "codex/fix/flaky-e2e" },
  { id: "unknown", branch: "greg/scratch" },
  { id: "bare", branch: "scratch-pad" },
  {
    id: "long",
    branch: "feature/issue-4821-stream-upload-retry-with-exponential-backoff-and-jitter",
  },
  { id: "muted", branch: "chore/bump-vite", muted: true },
];

function worktreeFor(card: CardFixture): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id: `wt-${card.id}`,
    worktreeId: `wt-${card.id}`,
    path: `/Users/dev/helios-worktrees/${card.id}`,
    name: card.main ? "helios-dashboard" : card.id,
    branch: card.branch,
    isCurrent: false,
    isMainWorktree: !!card.main,
    ...clean,
    ...card.fields,
  } as unknown as WorktreeState;
}

function Card({ card }: { card: CardFixture }) {
  const worktree = worktreeFor(card);
  return (
    <div
      data-preview-row={card.id}
      className={cn(
        "sidebar-worktree-card group/card relative isolate",
        !card.active && "bg-transparent"
      )}
      data-variant="sidebar"
      data-active={card.active ? "true" : undefined}
      data-has-grip={card.main ? undefined : "true"}
    >
      <div className="relative z-10 flex">
        {!card.main && (
          <div
            data-worktree-row-drag-handle=""
            className="flex w-4 shrink-0 items-center justify-center text-text-muted opacity-0"
            aria-hidden="true"
          >
            <GripVertical className="h-3 w-3" />
          </div>
        )}
        <div className={cn("min-w-0 flex-1 pe-4", card.main ? "ps-4" : "ps-0")}>
          <div className="pt-2">
            <WorktreeHeader
              worktree={worktree}
              isActive={!!card.active}
              isMuted={card.muted}
              variant="sidebar"
              isMainWorktree={!!card.main}
              isMainOnStandardBranch={isMainWorktreeOnStandardBranch(worktree)}
              isPinned={false}
              isCollapsed={false}
              canCollapse
              onToggleCollapse={noop}
              contentId={`worktree-body-${worktree.id}`}
              branchLabel={card.branch}
              badges={{}}
              gitStateIndicator={null}
              menu={menu}
            />
          </div>
          <div className="pb-2" />
        </div>
      </div>
    </div>
  );
}

const AGENT_BRANCHES = ["claude", "codex", "copilot", "cursor", "devin"];

/** Every glyph the label can draw, at the label's real size, in one sheet. */
function Glyphs() {
  const branches = [
    ...BRANCH_TYPES.map((type) => `${type.prefix}/${type.id}`),
    ...AGENT_BRANCHES.map((agent) => `${agent}/${agent}-agent`),
    "greg/unknown-prefix",
    "bare-branch-name",
  ];
  return (
    <div
      data-preview-card
      className="grid grid-cols-4 gap-x-6 gap-y-2.5 bg-surface-sidebar p-4"
      style={{ width: 640 }}
    >
      {branches.map((branch) => (
        <div key={branch} data-preview-glyph={branch} className="min-w-0">
          <BranchLabel label={branch} isActive={false} />
        </div>
      ))}
    </div>
  );
}

function Body() {
  if (fixtureName === "glyphs") return <Glyphs />;
  return (
    <div data-preview-card className="sidebar-root bg-surface-sidebar" style={{ width }}>
      {CARDS.map((card) => (
        <Card key={card.id} card={card} />
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
