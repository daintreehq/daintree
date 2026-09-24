import { Check, FileCode, GitBranch, GitCommitHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_RECT, MockApp, MockGrid, MockWorktreeCard } from "../mockup/MockApp";
import {
  MockCursor,
  MockLines,
  MockPane,
  MockTyping,
  reveal,
  useMockCursor,
  type CursorStep,
} from "../mockup/TourMock";
import { useCue, useTimelineIndex, type TimelinePoint } from "../useTourPlayer";
import { MockSpotlight, MockTooltip } from "./sceneParts";

const FILES = [
  { name: "Header.tsx", added: 24, removed: 3 },
  { name: "SearchBox.tsx", added: 58, removed: 0 },
  { name: "header.css", added: 12, removed: 1 },
] as const;

type DiffKind = "context" | "insert" | "delete";
const DIFF: ReadonlyArray<{ kind: DiffKind; width: number }> = [
  { kind: "context", width: 62 },
  { kind: "context", width: 48 },
  { kind: "delete", width: 70 },
  { kind: "insert", width: 76 },
  { kind: "insert", width: 58 },
  { kind: "insert", width: 84 },
  { kind: "context", width: 40 },
  { kind: "insert", width: 66 },
  { kind: "context", width: 52 },
];
const DIFF_STEPS: readonly TimelinePoint[] = DIFF.map((_, i) => ({
  cue: "diff",
  offset: i * 0.12,
}));
const DIFF_ROW: Record<DiffKind, string> = {
  context: "bg-transparent",
  insert: "bg-diff-insert-background",
  delete: "bg-diff-delete-background",
};

// The card's review icon, and the commit button inside the review. The card is
// the third in the sidebar; measured from the render.
const REVIEW_BUTTON = { x: 134, y: 243 };
const PANE_INPUT = { x: GRID_RECT.x + 80, y: GRID_RECT.y + GRID_RECT.height - 11 };
const COMMIT_BUTTON = {
  x: GRID_RECT.x + GRID_RECT.width - 44,
  y: GRID_RECT.y + GRID_RECT.height - 16,
};
// The message is written before the pointer reaches Commit & Push.
const COMMIT_TYPED = { cue: "commit", offset: 1.6 } as const;
const FILES_CUE = { cue: "files", offset: -0.3 } as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "ask", offset: -0.4, at: PANE_INPUT },
  { cue: "ask", at: PANE_INPUT, click: true },
  { cue: "open", offset: -0.6, at: REVIEW_BUTTON },
  { cue: "open", offset: 0.55, at: REVIEW_BUTTON, click: true },
  { cue: "commit", offset: 1.6, at: COMMIT_BUTTON },
  { cue: "commit", offset: 2.3, at: COMMIT_BUTTON, click: true },
];

function ReviewSurface({
  visible,
  diffStep,
  typing,
  pushed,
}: {
  visible: boolean;
  diffStep: number;
  typing: boolean;
  pushed: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-panel shadow-[var(--theme-shadow-ambient)]",
        reveal(visible)
      )}
      style={{
        left: GRID_RECT.x,
        top: GRID_RECT.y,
        width: GRID_RECT.width,
        height: GRID_RECT.height,
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        <span className="text-2xs font-semibold text-text-primary">Review &amp; commit</span>
        <span className="flex items-center gap-1 rounded-sm bg-overlay-subtle px-1 font-mono text-3xs text-text-secondary">
          <GitBranch className="size-2.5" aria-hidden="true" />
          add-search
        </span>
      </div>
      {/* Once pushed nothing is left to commit, so the list and the commit bar
          give way to the clean state, as the real surface does. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center gap-1.5 text-2xs text-text-secondary",
          pushed ? "flex" : "hidden"
        )}
      >
        <Check className="size-3" aria-hidden="true" />
        Working tree clean
      </div>
      <div className={cn("min-h-0 flex-1", pushed ? "hidden" : "flex")}>
        <div className="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-border-subtle p-1.5">
          <span className="px-1.5 pb-0.5 text-3xs font-semibold text-text-secondary">Staged</span>
          {FILES.map((file, i) => (
            <div
              key={file.name}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-150 ease-out",
                i === 0 && diffStep >= 0 ? "bg-overlay-selected" : "bg-transparent"
              )}
            >
              <FileCode className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-3xs text-text-primary">
                {file.name}
              </span>
              <span className="text-3xs tabular-nums text-status-success">+{file.added}</span>
              {file.removed > 0 && (
                <span className="text-3xs tabular-nums text-status-error">−{file.removed}</span>
              )}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
          {DIFF.map((row, i) => (
            <div
              key={i}
              className={cn(
                "flex h-3.5 items-center rounded-sm px-1.5 transition-opacity duration-150 ease-out",
                DIFF_ROW[row.kind],
                i <= diffStep ? "opacity-100" : "opacity-0"
              )}
            >
              <span className="w-3 shrink-0 text-3xs text-text-secondary">
                {row.kind === "insert" ? "+" : row.kind === "delete" ? "−" : ""}
              </span>
              <span
                className="h-1 rounded-full bg-overlay-strong"
                style={{ width: `${row.width}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      <div
        className={cn(
          "shrink-0 items-center gap-2 border-t border-border-subtle p-2",
          pushed ? "hidden" : "flex"
        )}
      >
        <div className="flex h-6 min-w-0 flex-1 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs">
          <MockTyping
            cue="commit"
            text="Add search to the header"
            delay={0.2}
            finishBy={COMMIT_TYPED}
          />
          {!typing && <span className="text-text-placeholder">Commit message…</span>}
        </div>
        <span className="flex h-6 items-center gap-1 rounded-md bg-text-primary px-2.5 text-3xs font-medium text-text-inverse">
          Commit &amp; Push
        </span>
      </div>
    </div>
  );
}

export function ReviewScene() {
  const asking = useCue("ask", 0.2);
  const changes = useCue("files");
  const hovering = useCue("open");
  const opened = useCue("open", 0.65);
  const diffStep = useTimelineIndex(DIFF_STEPS);
  const typing = useCue("commit", 0.2);
  const pushed = useCue("commit", 2.6);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);

  return (
    <MockApp
      branch={"add-search"}
      focus={changes && !opened ? ["sidebar"] : ["grid"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard
            name="add-search"
            branch="add-search"
            selected
            states={["completed"]}
            changes={pushed ? undefined : "3 files +94/−4"}
            action={
              pushed ? undefined : (
                <span
                  data-tour-anchor="review-commit"
                  className="flex shrink-0 items-center text-[var(--color-state-active)]"
                >
                  <GitCommitHorizontal className="size-3" aria-hidden="true" />
                </span>
              )
            }
          />
        </>
      }
      grid={
        <MockGrid columns={1}>
          <MockPane
            agent="claude"
            state="completed"
            focused={!changes}
            input={
              asking && !changes ? (
                <MockTyping
                  cue="ask"
                  text="Commit and push this"
                  delay={0.2}
                  finishBy={FILES_CUE}
                />
              ) : null
            }
          >
            <MockLines widths={[82, 60, 90, 54, 72, 64]} />
          </MockPane>
        </MockGrid>
      }
      overlay={
        <ReviewSurface visible={opened} diffStep={diffStep} typing={typing} pushed={pushed} />
      }
    >
      {/* "Its worktree in the sidebar shows what changed" — the card and its button. */}
      <MockSpotlight
        targets={hovering ? ["review-commit"] : ["worktree-add-search"]}
        visible={changes && !opened}
      />
      <MockTooltip
        visible={hovering && !opened}
        x={REVIEW_BUTTON.x}
        y={REVIEW_BUTTON.y + 12}
        title="Review & commit"
      />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
