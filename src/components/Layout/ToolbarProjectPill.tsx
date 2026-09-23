import type { ComponentPropsWithRef } from "react";
import { ChevronsUpDown, FileText, GitBranch, GitCommitHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkeletonBone } from "@/components/ui/Skeleton";
import { truncateBranchName } from "@/utils/textParsing";
import type { ActiveWorkspaceIdentity, BranchChipState } from "@/lib/workspaceIdentity";

/** Characters of branch name the chip shows before it middle-truncates. */
export const PILL_BRANCH_BUDGET = 24;

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

export function shortSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
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
  // `max-w-md` protects the titlebar's drag area: past it the name end-truncates
  // and the full identity is in the tooltip.
  return (
    <button
      data-toolbar-item=""
      className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-md items-center justify-center gap-2 overflow-hidden border px-3 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      data-testid="project-switcher-trigger"
      aria-label={workspaceIdentity.ariaLabel}
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
          className="toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums"
          aria-label={
            chipState === "visible"
              ? `Current branch ${branchName}`
              : chipState === "detached"
                ? `Detached at ${shortSha(headSha) ?? "unknown commit"}`
                : undefined
          }
          aria-hidden={chipState === "reserved" ? true : undefined}
        >
          {chipState === "detached" ? (
            <GitCommitHorizontal className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
          ) : (
            <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
          )}
          {chipState === "reserved" ? (
            // Roughly a short branch's width, so the pill barely moves when it lands.
            <SkeletonBone className="h-1.5 w-10 rounded-full" />
          ) : (
            <span className="toolbar-project-chip-label">
              {chipState === "visible" && branchName
                ? truncateBranchName(branchName, PILL_BRANCH_BUDGET)
                : (shortSha(headSha) ?? "detached")}
            </span>
          )}
        </span>
      )}
      <ChevronsUpDown className="toolbar-project-meta h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
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
        <div className="text-text-secondary font-mono text-2xs break-all">{path}</div>
      ) : (
        <div className="text-text-secondary text-2xs">Scratch workspace</div>
      )}
    </div>
  );
}
