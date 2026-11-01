import { Fragment, type ComponentPropsWithRef } from "react";
import { ChevronsUpDown, FileText, GitBranch, GitCommitHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { shortSha } from "@/utils/textParsing";
import type { ActiveWorkspaceIdentity, BranchChipState } from "@/lib/workspaceIdentity";

/** Characters of a branch's end that never truncate: usually what tells two apart. */
const BRANCH_TAIL = 8;

export interface ToolbarProjectPillProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  workspaceIdentity: ActiveWorkspaceIdentity;
  /** The open project's emoji; undefined when no project is open. */
  emoji: string | undefined;
  chipState: BranchChipState;
  branchName: string | undefined;
  /** HEAD's commit, shown when the chip is `detached`. */
  headSha: string | undefined;
  isDropdownOpen: boolean;
}

/**
 * The titlebar's workspace switcher trigger. Presentational: the toolbar owns
 * the popover, context menu and tooltip wrapped around it, and Radix's `asChild`
 * triggers merge their props and ref onto this button through `...rest`.
 */
export function ToolbarProjectPill({
  workspaceIdentity,
  emoji,
  chipState,
  branchName,
  headSha,
  isDropdownOpen,
  ...rest
}: ToolbarProjectPillProps) {
  // Capped at a third of the strip as well as `max-w-md`, so on a narrow window
  // a long name truncates before the tools either side start folding into
  // their `…` menus. Past the cap the name end-truncates and the full identity
  // is in the tooltip.
  const chipText =
    chipState === "visible" && branchName ? branchName : (shortSha(headSha) ?? "detached");
  // Only a label long enough to cut takes the cut's floor and yields first; a
  // short one (main, a short SHA) is its own width and never pads.
  const chipTruncates = chipState === "visible" && chipText.length > BRANCH_TAIL + 4;
  // The button's own label wins over anything inside it, so the branch the
  // chip shows has to be said here.
  const chipSpoken =
    chipState === "visible" && branchName
      ? `, current branch ${branchName}`
      : chipState === "detached"
        ? `, detached at ${shortSha(headSha) ?? "unknown commit"}`
        : "";
  return (
    <button
      data-toolbar-item=""
      className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-[min(28rem,32cqw)] items-center justify-center gap-2 overflow-hidden border px-3 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      data-testid="project-switcher-trigger"
      aria-label={`${workspaceIdentity.ariaLabel}${chipSpoken}`}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={isDropdownOpen}
      {...rest}
    >
      {workspaceIdentity.kind === "scratch" && (
        <FileText className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      {workspaceIdentity.kind === "project" && (
        <span className="text-base leading-none shrink-0" aria-hidden="true">
          {emoji}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 truncate text-xs tracking-wide text-text-primary",
          workspaceIdentity.kind !== "none" ? "font-semibold" : "font-medium"
        )}
      >
        {workspaceIdentity.name}
      </span>
      {chipState !== "hidden" && (
        <span
          // Yields before the name does, and only from its middle: the chip
          // shrinks first by a wide margin, its head truncates while its last
          // few characters stay, so a squeezed chip reads "fea…rotation" rather
          // than "feature/…" — and the project, what the pill exists to say, is
          // the last thing to give way. The floor is the chrome (padding, glyph,
          // gap, border) plus three characters of head, the ellipsis and the
          // whole tail; past it the name shrinks instead, so the tail never
          // runs under the chevrons. The cap is 24 characters of text.
          className={cn(
            "toolbar-project-chip inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums",
            chipTruncates
              ? "min-w-[calc(12ch+1.75rem+2px)] max-w-[calc(24ch+1.75rem+2px)] shrink-[999] overflow-hidden"
              : "shrink-0"
          )}
          aria-hidden="true"
        >
          {chipState === "detached" ? (
            <GitCommitHorizontal className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
          ) : (
            <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
          )}
          {chipState === "reserved" ? (
            // An invisible short-branch-width run of mono text gives the placeholder
            // the label's own line box, so neither the chip's height nor a short
            // branch's width changes when the name lands. The bone sits over it.
            <span className="toolbar-project-chip-label relative">
              <span className="invisible">{"0".repeat(7)}</span>
              <SkeletonBone className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" />
            </span>
          ) : (
            <BranchChipLabel text={chipText} />
          )}
        </span>
      )}
      <ChevronsUpDown className="toolbar-project-meta h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  );
}

/**
 * The chip's label, cut in the middle by CSS rather than a character budget,
 * so it takes exactly the room the pill can spare and never ends up with two
 * ellipses: the head truncates down to a few characters, the tail never does.
 */
function BranchChipLabel({ text }: { text: string }) {
  if (text.length <= BRANCH_TAIL + 4) {
    return <span className="toolbar-project-chip-label">{text}</span>;
  }
  return (
    <span className="toolbar-project-chip-label flex min-w-0">
      <span className="min-w-[4ch] truncate">{text.slice(0, -BRANCH_TAIL)}</span>
      {/* The mono ellipsis carries a full cell of side-bearing; pulled in a
          pixel the cut reads as one word rather than two. */}
      <span className="-ml-px shrink-0">{text.slice(-BRANCH_TAIL)}</span>
    </span>
  );
}

/** What the pill's hover tooltip says: everything the pill had to truncate. */
export function ToolbarProjectPillTooltipBody({
  name,
  branchLabel,
  path,
}: {
  name: string;
  branchLabel: string | undefined;
  path: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xs font-medium break-words">
        {name}
        {branchLabel ? ` · ${branchLabel}` : ""}
      </div>
      {path ? (
        // Breaks after a separator where it can, inside a segment only where it must.
        <div className="text-text-secondary font-mono break-words">
          {path.split(/(?<=[/\\])/).map((segment, i) => (
            <Fragment key={i}>
              {segment}
              <wbr />
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="text-text-secondary">Scratch workspace</div>
      )}
    </div>
  );
}
