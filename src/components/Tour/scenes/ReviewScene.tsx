import { Check, FileCode } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { MockCursor, MockTyping, reveal, useMockCursor, type CursorStep } from "../mockup/TourMock";
import { useCue, useTimelineIndex, type TimelinePoint } from "../useTourPlayer";

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

const COMMIT_BUTTON = { x: 522, y: 262 };
const CURSOR: readonly CursorStep[] = [
  { cue: "commit", offset: 1.6, at: COMMIT_BUTTON },
  { cue: "commit", offset: 2.3, at: COMMIT_BUTTON, click: true },
];

const DIFF_ROW: Record<DiffKind, string> = {
  context: "bg-transparent",
  insert: "bg-diff-insert-background",
  delete: "bg-diff-delete-background",
};

export function ReviewScene() {
  const files = useCue("files");
  const diffStep = useTimelineIndex(DIFF_STEPS);
  const typing = useCue("commit", 0.2);
  const pushed = useCue("commit", 2.4);
  const outro = useCue("outro");
  const cursor = useMockCursor({ x: 600, y: 330 }, CURSOR);

  return (
    <div className="relative size-full">
      <div
        className={cn(
          "absolute left-[50px] top-[22px] flex h-[264px] w-[540px] flex-col overflow-hidden rounded-lg border border-border-default bg-surface-panel",
          reveal(files && !outro)
        )}
      >
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-border-subtle p-2">
            <span className="px-2 pb-1 pt-0.5 text-3xs font-semibold text-text-secondary">
              Changes
            </span>
            {FILES.map((file, i) => (
              <div
                key={file.name}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 ease-out",
                  i === 0 && diffStep >= 0 ? "bg-overlay-selected" : "bg-transparent"
                )}
              >
                <FileCode className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-2xs text-text-primary">
                  {file.name}
                </span>
                <span className="text-3xs tabular-nums text-status-success">+{file.added}</span>
                {file.removed > 0 && (
                  <span className="text-3xs tabular-nums text-status-error">−{file.removed}</span>
                )}
              </div>
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
            {DIFF.map((row, i) => (
              <div
                key={i}
                className={cn(
                  "flex h-4 items-center rounded-sm px-2 transition-opacity duration-150 ease-out",
                  DIFF_ROW[row.kind],
                  i <= diffStep ? "opacity-100" : "opacity-0"
                )}
              >
                <span className="w-3 shrink-0 text-3xs text-text-secondary">
                  {row.kind === "insert" ? "+" : row.kind === "delete" ? "−" : ""}
                </span>
                <span
                  className="h-1.5 rounded-full bg-overlay-strong"
                  style={{ width: `${row.width}%` }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle p-2.5">
          <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border-input bg-surface-input px-2 text-2xs">
            <MockTyping cue="commit" text="Add search to the header" delay={0.2} />
            {!typing && <span className="text-text-placeholder">Commit message…</span>}
          </div>
          <span className="flex h-7 items-center gap-1.5 rounded-md bg-text-primary px-3 text-2xs font-medium text-text-inverse">
            {pushed && <Check className="size-3" aria-hidden="true" />}
            Commit &amp; Push
          </span>
        </div>
      </div>

      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-3",
          reveal(outro, "none")
        )}
      >
        <DaintreeIcon className="size-12 text-text-primary" />
        <span className="text-base font-semibold text-text-primary">You're ready</span>
        <span className="text-2xs text-text-secondary">
          Replay any time from Help › Daintree Tour
        </span>
      </div>

      <MockCursor {...cursor} visible={cursor.visible && !outro} />
    </div>
  );
}
