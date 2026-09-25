import {
  CircleDot,
  Copy,
  CornerDownRight,
  ExternalLink,
  GitPullRequest,
  MoreHorizontal,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import { ANCHOR, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import { MockCIGlyph } from "../mockup/MockCIGlyph";
import {
  MockCursor,
  MockLines,
  MockPane,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue } from "@daintreehq/tour/react";
import { MockEmptyGrid, MockMenu, MockSearchField, MockSpotlight } from "./sceneParts";

const ISSUES = ANCHOR["forge-issues"];
const LIST = { x: 290, y: ISSUES.y + 14, width: 216 };
// Clicking an issue opens it on the forge; a worktree comes from the row's
// actions menu. #51 is the second row; its menu button is measured from the render.
const ISSUE_MENU = { x: 487, y: 91 };
const ROW_MENU = { x: ISSUE_MENU.x - 132, y: ISSUE_MENU.y + 10, width: 140 };
const CREATE_ITEM = { x: ROW_MENU.x + 50, y: ROW_MENU.y + 17 };

const DIALOG = { x: 230, y: 90, width: 250 };
const CREATE_BUTTON = { x: 417, y: 189 };
const BRANCH = "feature/issue-51-dark-mode-for-settings";

const ISSUES_LIST = [
  ["#52 Checkout total rounds wrong", "2h"],
  ["#51 Dark mode for settings", "1d"],
  ["#48 Slow product images", "3d"],
  ["#45 Add order history", "5d"],
] as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "list", at: ISSUES },
  { cue: "list", offset: 0.5, at: ISSUES, click: true },
  { cue: "pick", at: ISSUE_MENU },
  { cue: "pick", offset: 0.5, at: ISSUE_MENU, click: true },
  { cue: "choose", at: CREATE_ITEM },
  { cue: "choose", offset: 0.5, at: CREATE_ITEM, click: true },
  { cue: "create", at: CREATE_BUTTON },
  { cue: "create", offset: 0.6, at: CREATE_BUTTON, click: true },
];

export function GitHubScene() {
  const pill = useCue("pill");
  const listOpen = useCue("list", 0.6);
  const rowMenu = useCue("pick", 0.6);
  const dialog = useCue("choose", 0.6);
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
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
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
              {/* The app's own pending dot, then its passing check, just larger so the change reads. */}
              <MockCIGlyph status={checksPassed ? "success" : "pending"} />
            </span>
          </MockWorktreeCard>
        </>
      }
      grid={
        created ? (
          <MockEmptyGrid label="Dark mode for settings" />
        ) : (
          <MockGrid columns={1}>
            <MockPane agent="claude" state={null}>
              <MockLines widths={[70, 54, 82]} />
            </MockPane>
          </MockGrid>
        )
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
            <span className="text-text-secondary">Search issues…</span>
          </MockSearchField>
        }
        items={ISSUES_LIST.map(([label, age], i) => ({
          icon: <CircleDot />,
          label,
          hint: (
            <span className="flex items-center gap-1.5">
              {age}
              <span
                data-tour-anchor={i === 1 ? "issue-51-menu" : undefined}
                className={cn(
                  "inline-flex rounded-sm",
                  i === 1 && rowMenu && "bg-overlay-medium text-text-primary"
                )}
              >
                <MoreHorizontal aria-hidden="true" />
              </span>
            </span>
          ),
        }))}
      />
      <MockMenu
        visible={rowMenu && !dialog}
        anchor="issue-actions"
        active={0}
        x={ROW_MENU.x}
        y={ROW_MENU.y}
        width={ROW_MENU.width}
        items={[
          { icon: <FolderGit2 />, label: "Create worktree" },
          { icon: <ExternalLink />, label: "Open on GitHub" },
          { icon: <Copy />, label: "Copy number" },
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
          <span
            data-tour-anchor="github-create"
            className="rounded-md bg-text-primary px-2.5 py-1 text-3xs font-medium text-text-inverse"
          >
            Create worktree
          </span>
        </div>
      </div>
      <MockCursor {...cursor} visible={cursor.visible && !created} />
    </MockApp>
  );
}
