import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

/**
 * The parts every git confirm preview is built from — push, pull-and-rebase,
 * force push and the worktree base operations.
 *
 * They were four private copies, and the copies drifted: a label column 40px
 * wide in one dialog and 56px in the next, one dialog dimming the local ref and
 * its sibling not, blocking copy phrased two different ways, a spinner where the
 * others drew a gated skeleton. Each dialog now decides WHAT it says; how a ref,
 * a blocked state or a commit row looks is decided once, here.
 */

const SHORT_HASH_LEN = 7;

/** Rows the loading skeleton draws. Enough to hold the frame's height without claiming a count. */
const SKELETON_ROWS = 3;

export interface PreviewCommit {
  hash: string;
  message: string;
  author: string;
}

/** The bordered region that holds everything deciding whether the operation may proceed. */
export function PreviewFrame({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-tint/[0.08] bg-tint/[0.04] text-xs">{children}</div>;
}

export function PreviewSummary({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <dl className="px-3 py-2 space-y-1.5" data-testid={testId}>
      {children}
    </dl>
  );
}

/**
 * One label/value pair. The label column is sized for the longest label the
 * family uses ("Rewrites"), so every dialog's refs start on the same line.
 * `aside` is a short qualifier on the value — "creates this branch", "14 incoming".
 */
export function SummaryRow({
  label,
  children,
  aside,
}: {
  label: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-3xs uppercase tracking-wider text-text-secondary shrink-0 w-16">
        {label}
      </dt>
      <dd className="flex-1 min-w-0">
        {aside ? (
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            {children}
            <span className="text-3xs text-text-secondary">{aside}</span>
          </span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

/**
 * A ref as a value rather than a word in a sentence.
 *
 * Wraps rather than truncates: which branch and which repository is the one
 * fact on these surfaces that must never be shortened, and a long fork ref
 * across three lines beats an ellipsis in the middle of the repository name.
 */
export function RefChip({ value }: { value: string }) {
  return (
    <span className="inline-flex items-baseline px-1.5 py-0.5 rounded-lg bg-tint/[0.07] border border-tint/[0.08] text-2xs font-mono text-text-primary break-words">
      {value}
    </span>
  );
}

/**
 * Git answered and there was nothing to name, or git did not answer at all.
 * Neutral on purpose: the reason is stated once, in the notice at the top of the
 * frame, and a second red word on the row only repeated it.
 */
export function MissingValue({ label = "—" }: { label?: string }) {
  return <span className="text-text-secondary text-2xs">{label}</span>;
}

/**
 * Skeleton bone. `animate-pulse-delayed` carries the 400ms Doherty gate in its
 * own `animation-delay`, so a read that returns quickly paints nothing at all.
 */
export function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-3.5 rounded-lg bg-tint/[0.08] animate-pulse-delayed", className)}
    />
  );
}

export function PreviewSectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="px-3 py-2 border-t border-tint/[0.08] first:border-t-0">
      <span
        role="heading"
        aria-level={3}
        className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
      >
        {label}
        {count !== undefined && count > 0 && (
          <span className="ml-1.5 tabular-nums bg-tint/10 rounded-lg px-1 py-0.5 text-3xs font-medium normal-case tracking-normal">
            {count}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * `Skeleton` is what makes the wait reach a screen reader: the bones alone are
 * decorative, so a blocked primary with no announced busy state left an AT user
 * with a dead button and no explanation.
 */
export function PreviewSkeleton({ label, testId }: { label: string; testId?: string }) {
  return (
    <Skeleton
      label={label}
      data-testid={testId}
      className="border-t border-tint/[0.08] first:border-t-0"
    >
      <ul className="px-3 py-2 space-y-1.5">
        {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <Bone className="w-[3.5rem]" />
            <Bone className={i === 1 ? "w-40" : "w-52"} />
            <Bone className="w-16 ml-auto" />
          </li>
        ))}
      </ul>
    </Skeleton>
  );
}

/**
 * The one fact that changes what the user should do: a state that blocks the
 * operation (`error`), or one that lets it through but not as expected
 * (`warning` — a push git will refuse, a list that couldn't be checked).
 *
 * It sits at the TOP of the frame, above the refs. It used to come last, under a
 * paragraph, the refs and a section heading, so the reason a push was blocked
 * was the fifth thing on the dialog to be read.
 */
export function PreviewNotice({
  tone,
  title,
  children,
  command,
  onRetry,
  retryTestId,
  testId,
}: {
  tone: "error" | "warning";
  title: string;
  children?: ReactNode;
  /** A command the user can run as-is, shown on its own line and never clipped. */
  command?: string;
  onRetry?: () => void;
  retryTestId?: string;
  testId?: string;
}) {
  const isError = tone === "error";
  return (
    <div
      className="px-3 py-2.5 flex items-start gap-2 border-b border-tint/[0.08]"
      role={isError ? "alert" : "status"}
    >
      <AlertTriangle
        aria-hidden="true"
        className={cn(
          "w-3.5 h-3.5 mt-0.5 shrink-0",
          isError ? "text-status-error" : "text-status-warning"
        )}
      />
      <div className="flex-1 min-w-0" data-testid={testId}>
        <div className={cn("font-medium", isError ? "text-status-error" : "text-status-warning")}>
          {title}
        </div>
        {children && <div className="mt-0.5 text-text-secondary break-words">{children}</div>}
        {command && (
          <code className="mt-1 block font-mono text-text-primary break-all">{command}</code>
        )}
        {onRetry && (
          <Button
            variant={isError ? "ghost-danger" : "ghost"}
            size="sm"
            onClick={onRetry}
            data-testid={retryTestId}
            className="mt-1.5 -ml-2 h-6 px-2 text-2xs"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

/** A plain statement standing in for a list — "nothing to publish", "14 behind". */
export function PreviewNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="px-3 py-2.5 text-text-secondary border-t border-tint/[0.08] first:border-t-0"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * A bounded commit list.
 *
 * A scrollable region with no focusable children of its own has to be reachable
 * by keyboard in its own right (WCAG 2.1.1), and the fades are what say "there
 * is more" — a row clipped by the frame edge was the only previous cue, and a
 * clip that lands on a row boundary says the opposite.
 *
 * The tail, when the range runs past what was fetched, states the cap as a fact
 * rather than promising rows nothing can open.
 */
export function CommitRows({
  commits,
  total,
  label,
  rowTestId,
  capTestId,
  compact = false,
}: {
  commits: PreviewCommit[];
  total: number;
  label: string;
  rowTestId?: string;
  capTestId?: string;
  /** A shorter region, for a second list sharing the frame. */
  compact?: boolean;
}) {
  const hidden = Math.max(0, total - commits.length);
  return (
    <ScrollShadow
      className={cn(
        "border-t border-tint/[0.08] first:border-t-0",
        compact ? "max-h-[132px]" : "max-h-[180px]"
      )}
      scrollClassName="scroll-py-8"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <ul className="px-3 py-2 space-y-1.5">
        {commits.map((commit) => (
          <li key={commit.hash} className="flex items-baseline gap-2" data-testid={rowTestId}>
            <span className="font-mono text-2xs text-text-secondary shrink-0 tabular-nums">
              {commit.hash.slice(0, SHORT_HASH_LEN)}
            </span>
            {/* The full subject on hover. Two long subjects sharing a prefix are
                otherwise indistinguishable once both are clipped. */}
            <span className="flex-1 min-w-0 truncate text-text-primary" title={commit.message}>
              {commit.message}
            </span>
            {/* Bounded, unlike the rest of the row: an author is the least
                important column, and left unbounded a long name took 45% of the
                width and truncated the subject to twenty characters. */}
            <span
              className="text-2xs text-text-secondary shrink-0 max-w-[7rem] truncate"
              title={commit.author}
            >
              {commit.author}
            </span>
          </li>
        ))}
        {hidden > 0 && (
          <li className="text-2xs text-text-secondary pt-0.5" data-testid={capTestId}>
            Listing the {commits.length} most recent of {total}
          </li>
        )}
      </ul>
    </ScrollShadow>
  );
}
