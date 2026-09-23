import type { ComponentPropsWithRef } from "react";
import { ChevronsUpDown, FileText, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActiveWorkspaceIdentity, BranchChipState } from "@/lib/workspaceIdentity";

export interface ToolbarProjectPillProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  workspaceIdentity: ActiveWorkspaceIdentity;
  /** The open project's emoji; undefined when no project is open. */
  emoji: string | undefined;
  chipState: BranchChipState;
  branchName: string | undefined;
  truncatedBranchName: string | undefined;
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
  truncatedBranchName,
  isDropdownOpen,
  ...rest
}: ToolbarProjectPillProps) {
  const hasProject = emoji !== undefined;
  return (
    <button
      data-toolbar-item=""
      className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden border px-3 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      data-testid="project-switcher-trigger"
      aria-label={workspaceIdentity.ariaLabel}
      role={workspaceIdentity.kind !== "none" ? "combobox" : undefined}
      aria-haspopup={workspaceIdentity.kind !== "none" ? "listbox" : undefined}
      aria-expanded={workspaceIdentity.kind !== "none" ? isDropdownOpen : undefined}
      {...rest}
    >
      {workspaceIdentity.kind === "scratch" ? (
        <FileText
          className="h-4 w-4 leading-none shrink-0 text-text-secondary"
          aria-hidden="true"
        />
      ) : (
        <span
          className={cn("text-base leading-none shrink-0", !hasProject && "opacity-0")}
          aria-label={hasProject ? "Project emoji" : undefined}
          aria-hidden={hasProject ? undefined : true}
        >
          {emoji ?? "•"}
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
          className={cn(
            "toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums",
            chipState === "reserved" && "opacity-0"
          )}
          aria-label={chipState === "visible" ? `Current branch ${branchName}` : undefined}
          aria-hidden={chipState === "visible" ? undefined : true}
        >
          <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
          <span className="toolbar-project-chip-label">
            {chipState === "visible" ? truncatedBranchName : "main"}
          </span>
        </span>
      )}
      <ChevronsUpDown className="toolbar-project-meta h-3 w-3 shrink-0" />
    </button>
  );
}
