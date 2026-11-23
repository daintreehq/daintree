import {
  CircleDot,
  Copy,
  CornerDownRight,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  MoreHorizontal,
  FolderGit2,
} from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockMenu,
  MockSearchField,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  ANCHOR,
  MockApp,
  MockCIGlyph,
  MockGrid,
  MockPane,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";
import { ReviewHub, type ReviewFile } from "./ReviewHub";

const ISSUES = ANCHOR["forge-issues"];
const LIST = { x: ISSUES.x - 153, y: ISSUES.y + 14, width: 216 };
// Clicking an issue opens it on the forge; a worktree comes from the row's
// actions menu. #51 is the second row; the menu opens under its button.
const ISSUE_MENU = { x: LIST.x + LIST.width - 19, y: 91 };
const ROW_MENU = { x: ISSUE_MENU.x - 132, y: ISSUE_MENU.y + 10, width: 140 };
const CREATE_ITEM = { anchor: "issue-actions-0", dx: -20 };

const DIALOG = { x: 230, y: 90, width: 250 };
const CREATE_BUTTON = { anchor: "github-create" };
const BRANCH = "feature/issue-51-dark-mode-for-settings";

const PANE_INPUT = { anchor: "claude-input", dx: -154, dy: 6 };
const REQUEST = "Commit, push and open the PR";
const REQUEST_TYPED = { cue: "pr", offset: 0.3 } as const;
const COMMIT_ICON = { anchor: "review-commit" };
const COMMIT_BUTTON = { anchor: "review-commit-push", dx: 13, dy: 5 };
const PUSH_CONFIRM = { anchor: "review-push-confirm" };
// "Steps you through every change": the first file's diff, then the next one's.
const FIRST_FILE = { anchor: "review-file-0", dx: -30 };
const SECOND_FILE = { anchor: "review-file-1", dx: -30 };
// The message is written as Review Hub opens, so it's ready by "commits".
const MESSAGE_TYPED = { cue: "diff", offset: -0.3 } as const;

const FILES: readonly ReviewFile[] = [
  { name: "SettingsPage.tsx", added: 31, removed: 6 },
  { name: "useTheme.ts", added: 18, removed: 2 },
  { name: "settings.css", added: 22, removed: 0 },
];

const ISSUES_LIST = [
  ["#52 Checkout total rounds wrong", "2h"],
  ["#51 Dark mode for settings", "1d"],
  ["#48 Slow product images", "3d"],
  ["#45 Add order history", "5d"],
] as const;

export const CURSOR: readonly CursorStep[] = [
  { cue: "list", at: { anchor: "forge-issues" } },
  { cue: "list", offset: 0.5, at: { anchor: "forge-issues" }, click: true },
  { cue: "pick", at: { anchor: "issue-51-menu" } },
  { cue: "pick", offset: 0.5, at: { anchor: "issue-51-menu" }, click: true },
  { cue: "choose", at: CREATE_ITEM },
  { cue: "choose", offset: 0.5, at: CREATE_ITEM, click: true },
  // The form is already on screen as the voice says the branch is named.
  { cue: "create", offset: -0.6, at: CREATE_BUTTON },
  { cue: "create", at: CREATE_BUTTON, click: true },
  { cue: "ask", offset: -0.5, at: PANE_INPUT },
  { cue: "ask", at: PANE_INPUT, click: true },
  { cue: "files", offset: 0.2, at: COMMIT_ICON },
  { cue: "open", offset: 0.4, at: COMMIT_ICON, click: true },
  { cue: "diff", offset: -0.45, at: FIRST_FILE },
  { cue: "diff", offset: 0.1, at: FIRST_FILE, click: true },
  { cue: "diff", offset: 0.5, at: SECOND_FILE },
  { cue: "diff", offset: 1.0, at: SECOND_FILE, click: true },
  { cue: "commit", offset: -0.3, at: COMMIT_BUTTON },
  { cue: "commit", offset: 0.2, at: COMMIT_BUTTON, click: true },
  // Commit & push opens the push confirm; its button names the destination.
  { cue: "commit", offset: 0.5, at: PUSH_CONFIRM },
  { cue: "commit", offset: 1.0, at: PUSH_CONFIRM, click: true },
];

export function GitHubScene() {
  const pill = useCue("pill");
  const listOpen = useCue("list", 0.6);
  const rowMenu = useCue("pick", 0.6);
  const dialog = useCue("choose", 0.6);
  const created = useCue("create", 0.2);
  // "When the agent's done": its turn ends just before it's asked.
  const agentDone = useCue("ask", -0.6);
  const asking = useCue("ask", 0.2);
  const sent = useCue("pr", 0.4);
  const prOpened = useCue("pr", 1.2);
  const badge = useCue("badge");
  const checksPassed = useCue("badge", 1.8);
  // "If you'd rather look first": the same card before anything was committed.
  const lookFirst = useCue("files");
  const opened = useCue("open", 0.6);
  const typing = useCue("open", 1.0);
  const firstFile = useCue("diff", 0.15);
  const secondFile = useCue("diff", 1.05);
  const confirming = useCue("commit", 0.3);
  const pushed = useCue("commit", 1.2);
  const cursor = useMockCursor({ x: 420, y: 200 }, CURSOR);

  const showPr = badge && !lookFirst;
  const paneState = sent && !prOpened ? "working" : agentDone ? "completed" : "working";

  return (
    <MockApp
      branch={created ? BRANCH : "main"}
      focus={
        opened
          ? ["grid"]
          : lookFirst || badge
            ? ["sidebar"]
            : agentDone
              ? ["grid"]
              : created
                ? ["sidebar", "grid"]
                : ["toolbar"]
      }
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
            states={created ? [paneState] : []}
            className={reveal(created, "left")}
            changes={lookFirst && !pushed ? "3 files +71/−8" : undefined}
            action={
              lookFirst && !pushed ? (
                <span
                  data-tour-anchor="review-commit"
                  className="flex shrink-0 items-center text-[var(--color-state-active)]"
                >
                  <GitCommitHorizontal className="size-3" aria-hidden="true" />
                </span>
              ) : undefined
            }
          >
            {/* The pull request sits under the issue, as the real card nests it. */}
            <span
              className={cn(
                "flex items-center gap-1 pl-[18px] text-3xs text-text-secondary [&_svg]:size-2.5",
                reveal(showPr, "none"),
                !showPr && lookFirst && "hidden"
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
          <MockGrid columns={1}>
            <MockPane
              agent="claude"
              state={paneState}
              focused={asking && !lookFirst}
              input={
                asking && !sent && !lookFirst ? (
                  <MockTyping cue="ask" text={REQUEST} delay={0.2} finishBy={REQUEST_TYPED} />
                ) : null
              }
            >
              <MockLines widths={[82, 60, 90, 54]} />
              {sent && !lookFirst && (
                <MockStreamingLines cue="pr" delay={0.4} widths={[70, 48]} perSecond={3} />
              )}
              <span
                className={cn(
                  "flex items-center gap-1 text-3xs text-text-primary [&_svg]:size-2.5",
                  reveal(prOpened && !lookFirst, "none")
                )}
              >
                <GitPullRequest aria-hidden="true" />
                Opened pull request #57
              </span>
            </MockPane>
          </MockGrid>
        ) : (
          <MockGrid columns={1}>
            <MockPane agent="claude" state={null}>
              <MockLines widths={[70, 54, 82]} />
            </MockPane>
          </MockGrid>
        )
      }
      overlay={
        <ReviewHub
          visible={opened}
          branch={BRANCH}
          files={FILES}
          selected={secondFile ? 1 : firstFile ? 0 : -1}
          message={
            typing ? (
              <MockTyping
                cue="open"
                text="Add dark mode to settings"
                delay={1.0}
                finishBy={MESSAGE_TYPED}
              />
            ) : null
          }
          confirming={confirming}
          pushed={pushed}
        />
      }
    >
      <MockSpotlight
        targets={lookFirst ? ["review-commit"] : badge ? ["worktree-issue-51"] : ["forge"]}
        visible={(pill && !listOpen) || (badge && !opened)}
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
      {/* Its last target leaves with the confirm, so the pointer goes once the push lands. */}
      <MockCursor {...cursor} visible={cursor.visible && !pushed} />
    </MockApp>
  );
}
