import { Check, FileCode, GitCommitHorizontal } from "lucide-react";
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
import { MockSpotlight } from "./sceneParts";

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

// The card's Review & Commit button, and the commit button inside the review.
// The card is the third in the sidebar; measured from the render.
const REVIEW_BUTTON = { x: 84, y: 248 };
const COMMIT_BUTTON = {
  x: GRID_RECT.x + GRID_RECT.width - 44,
  y: GRID_RECT.y + GRID_RECT.height - 16,
};
// The message is written before the pointer reaches Commit & Push.
const COMMIT_TYPED = { cue: "commit", offset: 1.6 } as const;

const CURSOR: readonly CursorStep[] = [
  { cue: "open", at: REVIEW_BUTTON },
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
        <span className="text-2xs font-semibold text-text-primary">Review</span>
        <span className="text-3xs text-text-secondary">add-search</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-border-subtle p-1.5">
          <span className="px-1.5 pb-0.5 text-3xs font-semibold text-text-secondary">Changes</span>
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
      <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle p-2">
        <div className="flex h-6 min-w-0 flex-1 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs">
          <MockTyping
            cue="commit"
            text="Add search to the header"
            delay={0.2}
            finishBy={COMMIT_TYPED}
          />
          {!typing && <span className="text-text-placeholder">Commit message…</span>}
        </div>
        {pushed ? (
          <span className="flex h-6 items-center gap-1 rounded-md border border-border-strong px-2.5 text-3xs font-medium text-text-primary">
            <Check className="size-3" aria-hidden="true" />
            Pushed to origin/add-search
          </span>
        ) : (
          <span className="flex h-6 items-center gap-1 rounded-md bg-text-primary px-2.5 text-3xs font-medium text-text-inverse">
            Commit &amp; Push
          </span>
        )}
      </div>
    </div>
  );
}

export function ReviewScene() {
  const changes = useCue("files");
  const opened = useCue("open", 0.65);
  const diffStep = useTimelineIndex(DIFF_STEPS);
  const typing = useCue("commit", 0.2);
  const pushed = useCue("commit", 2.4);
  const cursor = useMockCursor({ x: 420, y: 300 }, CURSOR);

  return (
    <MockApp
      branch={"add-search"}
      focus={opened ? ["grid"] : ["sidebar"]}
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard name="fix-login-redirect" branch="fix-login-redirect" />
          <MockWorktreeCard
            name="add-search"
            branch="add-search"
            selected
            states={["completed"]}
            changes={pushed ? undefined : "+94 −4"}
          >
            <span
              className={cn(
                "mt-0.5 flex items-center justify-center gap-1 rounded-sm border border-border-strong bg-surface-panel py-0.5 text-3xs font-medium text-text-primary",
                pushed && "opacity-0"
              )}
            >
              <GitCommitHorizontal className="size-2.5" aria-hidden="true" />
              Review &amp; Commit
            </span>
          </MockWorktreeCard>
        </>
      }
      grid={
        <MockGrid columns={1}>
          <MockPane agent="claude" state="completed">
            <MockLines widths={[82, 60, 90, 54, 72, 64]} />
          </MockPane>
        </MockGrid>
      }
      overlay={
        <ReviewSurface visible={opened} diffStep={diffStep} typing={typing} pushed={pushed} />
      }
    >
      {/* "Its worktree in the sidebar shows what changed" — the card and its button. */}
      <MockSpotlight targets={["worktree-add-search"]} visible={changes && !opened} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
