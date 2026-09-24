import { CircleDot, CornerDownRight, GitPullRequest } from "lucide-react";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import type { CIStatus } from "@shared/types/forge";
import { cn } from "@/lib/utils";
import { ANCHOR, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "../useTourPlayer";
import { MockMenu, MockSearchField, MockSpotlight } from "./sceneParts";

const ISSUES = ANCHOR["forge-issues"];
const LIST = { x: 300, y: ISSUES.y + 14, width: 200 };
const ISSUE_ROW = { x: LIST.x + 90, y: LIST.y + 38 };

// Picking an issue opens the new worktree form with its branch already named.
const DIALOG = { x: 230, y: 90, width: 250 };
const CREATE_BUTTON = { x: DIALOG.x + 200, y: DIALOG.y + 84 };
const BRANCH = "feature/issue-51-dark-mode-for-settings";

const CURSOR: readonly CursorStep[] = [
  { cue: "list", at: ISSUES },
  { cue: "list", offset: 0.5, at: ISSUES, click: true },
  { cue: "pick", at: ISSUE_ROW },
  { cue: "pick", offset: 0.5, at: ISSUE_ROW, click: true },
  { cue: "create", at: CREATE_BUTTON },
  { cue: "create", offset: 0.6, at: CREATE_BUTTON, click: true },
];

/**
 * The pull request's checks as the real card draws them — the app's own
 * pending dot, then its passing check — just larger, so the change reads.
 */
const CI_PENDING: CIStatus = {
  state: "pending",
  total: 3,
  passed: 1,
  failed: 0,
  pending: 2,
  rawData: null,
};
const CI_PASSED: CIStatus = {
  state: "success",
  total: 3,
  passed: 3,
  failed: 0,
  pending: 0,
  rawData: null,
};

function CIGlyph({ passed }: { passed: boolean }) {
  const visual = getCIStatusVisual(passed ? CI_PASSED : CI_PENDING);
  if (!visual) return null;
  return visual.kind === "icon" ? (
    <visual.Icon className={cn("size-3.5!", visual.colorClass)} aria-hidden="true" />
  ) : (
    <span className={cn("size-2.5 rounded-full", visual.colorClass)} aria-hidden="true" />
  );
}

export function GitHubScene() {
  const pill = useCue("pill");
  const listOpen = useCue("list", 0.6);
  const dialog = useCue("pick", 0.6);
  const created = useCue("create", 0.7);
  const badge = useCue("badge");
  const checksPassed = useCue("badge", 1.8);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  return (
    <MockApp
      branch={created ? BRANCH : "main"}
      focus={created ? ["sidebar"] : ["toolbar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" selected={!created} />
          <MockWorktreeCard name="add-search" branch="add-search" states={["completed"]} />
          <MockWorktreeCard
            name="issue-51"
            issueTitle="Dark mode for settings"
            branch={BRANCH}
            selected={created}
            className={reveal(created, "left")}
          >
            {/* The pull request sits under the issue, as the real card nests it. */}
            <span
              className={cn(
                "flex items-center gap-1 pl-[18px] text-3xs text-text-secondary [&_svg]:size-2.5",
                reveal(badge, "none")
              )}
            >
              <CornerDownRight aria-hidden="true" />
              <GitPullRequest aria-hidden="true" />
              #57
              <CIGlyph passed={checksPassed} />
            </span>
          </MockWorktreeCard>
        </>
      }
      grid={
        <MockGrid columns={1}>
          <MockPane agent="claude" state={null}>
            <MockLines widths={[70, 54, 82]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockSpotlight
        targets={badge ? ["worktree-issue-51"] : ["forge"]}
        visible={(pill && !listOpen) || badge}
      />
      <MockMenu
        visible={listOpen && !dialog}
        active={1}
        x={LIST.x}
        y={LIST.y}
        width={LIST.width}
        header={
          <MockSearchField>
            <span className="text-text-placeholder">Search issues…</span>
          </MockSearchField>
        }
        items={[
          { icon: <CircleDot />, label: "#52 Checkout total rounds wrong", hint: "2h" },
          { icon: <CircleDot />, label: "#51 Dark mode for settings", hint: "1d" },
          { icon: <CircleDot />, label: "#48 Slow product images", hint: "3d" },
          { icon: <CircleDot />, label: "#45 Add order history", hint: "5d" },
        ]}
      />
      <div
        className={cn(
          "absolute z-20 rounded-lg border border-border-strong bg-surface-dialog p-3 shadow-[var(--theme-shadow-ambient)]",
          reveal(dialog && !created)
        )}
        style={{ left: DIALOG.x, top: DIALOG.y, width: DIALOG.width }}
      >
        <div className="mb-2 text-xs font-semibold text-text-primary">Create worktree</div>
        <div className="mb-3 flex flex-col gap-1">
          <span className="text-3xs font-medium text-text-secondary">Name</span>
          <div className="flex h-5 items-center truncate rounded-md border border-border-input bg-surface-input px-2 text-3xs text-text-primary">
            {BRANCH}
          </div>
        </div>
        <div className="flex justify-end">
          <span className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse">
            Create worktree
          </span>
        </div>
      </div>
      <MockCursor {...cursor} visible={cursor.visible && !created} />
    </MockApp>
  );
}
