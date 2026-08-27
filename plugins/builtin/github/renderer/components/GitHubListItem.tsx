import { useState, useRef, useEffect } from "react";
import {
  CircleDot,
  CheckCircle2,
  GitPullRequest,
  GitPullRequestDraft,
  GitMerge,
  GitPullRequestClosed,
  MoreHorizontal,
  ExternalLink,
  Check,
  Copy,
  MessageSquare,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type { ForgeLabel, Issue, PR } from "@shared/types/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getPRCIStatusVisual, getPRCIStatusTooltip } from "../utils/prCIStatus";
import { toGitHubCIStatus } from "../utils/forgeRowAdapters";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import { RESOURCE_ITEM_HEIGHT_PX } from "./GitHubDropdownSkeletons";

interface GitHubListItemProps {
  item: Issue | PR;
  type: "issue" | "pr";
  onCreateWorktree?: (item: Issue | PR) => void;
  onSwitchToWorktree?: (worktreeId: string) => void;
  onOpenExternalUrl?: (url: string) => void;
  optionId?: string;
  /** DOM id for the row's actions trigger, so the grid can open it by key. */
  menuTriggerId?: string;
  /** One-based position in the grid, for `aria-rowindex` under virtualization. */
  rowIndex?: number;
  /** Whether this row's actions menu is open. Controlled by the grid so a
   *  programmatic close of the panel can take its child overlays with it. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** Where focus belongs once the row's actions menu closes. */
  onMenuClose?: () => void;
  isActive?: boolean;
  isSelected?: boolean;
  isSelectionActive?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
}

function getStateIcon(state: string, type: "issue" | "pr", isDraft?: boolean) {
  if (type === "issue") {
    return state === "open" ? CircleDot : CheckCircle2;
  }
  if (state === "merged") return GitMerge;
  // A draft reads as "open but not ready" — its own glyph, not the open one
  // recoloured. Colour alone can't carry the distinction on a 16px mark.
  if (state === "open") return isDraft ? GitPullRequestDraft : GitPullRequest;
  return GitPullRequestClosed;
}

function getStateColor(state: string, isDraft?: boolean): string {
  if (isDraft) return "text-pr-draft";
  if (state === "open") return "text-pr-open";
  if (state === "merged") return "text-pr-merged";
  return "text-pr-closed";
}

function isPR(item: Issue | PR): item is PR {
  return "isDraft" in item;
}

/** The trailing rail's only always-present slot, so rows share a right edge. */
const RAIL_SLOT = "shrink-0 flex items-center justify-center";

export function GitHubListItem({
  item,
  type,
  onCreateWorktree,
  onSwitchToWorktree,
  onOpenExternalUrl,
  optionId,
  menuTriggerId,
  rowIndex,
  menuOpen,
  onMenuOpenChange,
  onMenuClose,
  isActive,
  isSelected = false,
  isSelectionActive = false,
  onToggleSelect,
}: GitHubListItemProps) {
  const isItemPR = isPR(item);
  const StateIcon = getStateIcon(item.state, type, isItemPR && item.isDraft);
  const stateColor = getStateColor(item.state, isItemPR && item.isDraft);

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const matchedWorktree = useWorktreeStore((s) => {
    for (const wt of s.worktrees.values()) {
      if (type === "issue" ? wt.issueNumber === item.number : wt.prNumber === item.number)
        return wt;
    }
    return undefined;
  });
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const hasWorktree = matchedWorktree !== undefined;
  const isActiveWorktree = hasWorktree && matchedWorktree.id === activeWorktreeId;

  const handleOpenExternal = () => {
    if (onOpenExternalUrl) {
      onOpenExternalUrl(item.url);
      return;
    }
    void actionService.dispatch("system.openExternal", { url: item.url }, { source: "user" });
  };

  const handleCopyNumber = async () => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    try {
      await navigator.clipboard.writeText(`#${item.number}`);
      setCopied(true);
      copyTimeoutRef.current = window.setTimeout(
        () => setCopied(false),
        UI_ACTION_SUCCESS_DWELL_MS
      );
    } catch {
      setCopied(false);
    }
  };

  /**
   * The row's primary action — the same one Enter runs from the search field,
   * and total: a closed issue or a merged PR has no worktree to make, so it
   * falls through to the forge rather than swallowing the activation.
   */
  const runPrimaryAction = () => {
    if (hasWorktree && matchedWorktree && onSwitchToWorktree) {
      onSwitchToWorktree(matchedWorktree.id);
    } else if (item.state === "open" && onCreateWorktree) {
      onCreateWorktree(item);
    } else {
      handleOpenExternal();
    }
  };

  const handleOpenLinkedPR = () => {
    const linked = !isItemPR && "linkedPR" in item ? item.linkedPR : undefined;
    if (!linked) return;
    if (onOpenExternalUrl) {
      onOpenExternalUrl(linked.url);
      return;
    }
    void actionService.dispatch("system.openExternal", { url: linked.url }, { source: "user" });
  };

  const issueLabels: ForgeLabel[] = !isItemPR && "labels" in item ? (item.labels ?? []) : [];
  const [firstLabel, ...restLabels] = issueLabels;
  const assignees = !isItemPR ? item.assignees : [];
  const [firstAssignee, ...restAssignees] = assignees;

  const worktreeTooltip = isActiveWorktree
    ? "Active worktree"
    : hasWorktree && onSwitchToWorktree
      ? "Switch to worktree"
      : "Has worktree";

  return (
    <div
      id={optionId}
      /* A row, not an option. `option` admits no interactive descendants, and
         these rows genuinely carry them — a title that opens the issue, a
         number that copies, a linked-PR jump, an actions menu. The APG's
         editable-combobox-with-grid-popup pattern is the one that models this
         honestly: the input keeps DOM focus and points `aria-activedescendant`
         at a row, and every control lives inside a legal `gridcell`. */
      role="row"
      /* Virtualization means the DOM holds a window, not the list — without an
         explicit index a screen reader counts the handful of mounted rows. */
      aria-rowindex={rowIndex}
      data-testid={`github-item-${item.number}`}
      data-forge-row="true"
      data-active={isActive ? "true" : undefined}
      aria-selected={isSelected}
      className={cn(
        "forge-row group relative cursor-default select-none transition-colors duration-150 ease-out",
        // Neutral three-step ladder. Hover is the lightest fill, the keyboard
        // cursor adds the leading rail below, and membership is the heaviest
        // fill plus a filled checkbox — no accent anywhere (accent restraint:
        // the search field owns the one focus anchor in this region).
        "hover:bg-overlay-subtle",
        // Each step keeps its own floor under the pointer — otherwise hovering
        // the cursor row ran the ladder backwards and the row got *lighter*.
        isActive && "bg-overlay-soft hover:bg-overlay-soft",
        isSelected && "bg-overlay-medium hover:bg-overlay-medium",
        // The keyboard cursor's own mark, borrowed from `.palette-row`: a 3px
        // leading rail on `selection-outline`, which is the token that carries
        // 1.4.11's 3:1 against both the surface and the fill. Keyed on `isActive`
        // rather than `aria-selected`, which this listbox spends on membership.
        "before:absolute before:inset-y-1.5 before:-start-px before:w-[3px] before:rounded-full",
        "before:bg-selection-outline before:opacity-0 before:transition-opacity before:duration-150",
        "before:content-[''] before:pointer-events-none",
        isActive && "before:opacity-100"
      )}
      // The row draws to exactly the height Virtuoso lays it out on, so the
      // fill and the hit area cover the whole slot with no unowned strip.
      style={{ height: RESOURCE_ITEM_HEIGHT_PX }}
      onClick={(e) => {
        if (isSelectionActive && onToggleSelect) {
          onToggleSelect(e);
        } else {
          runPrimaryAction();
        }
      }}
    >
      <div role="gridcell" className="flex items-start gap-2.5 px-3 py-2.5 h-full">
        {onToggleSelect ? (
          <span className="group/icon shrink-0 relative w-4 h-4 mt-1">
            {/* State icon: visible by default, hidden on hover or when selection active */}
            <span
              className={cn(
                "absolute inset-0",
                stateColor,
                isSelectionActive || isSelected ? "hidden" : "group-hover/icon:hidden"
              )}
            >
              <StateIcon className="h-4 w-4" />
            </span>
            {/* Checkbox: hidden by default, visible on hover or when selection active */}
            <span
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(e);
              }}
              className={cn(
                "absolute inset-0 rounded border flex items-center justify-center cursor-pointer",
                "transition-colors duration-150 ease-out",
                isSelected
                  ? "bg-text-primary border-text-primary"
                  : "border-border-default hover:border-daintree-text/60",
                isSelectionActive || isSelected ? "flex" : "hidden group-hover/icon:flex"
              )}
            >
              {isSelected && <Check className="w-3 h-3 text-text-inverse" />}
            </span>
          </span>
        ) : (
          <span className={cn("shrink-0 mt-1", stateColor)}>
            <StateIcon className="h-4 w-4" />
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Title line: the title owns the width; status and actions sit in the rail. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (isSelectionActive && onToggleSelect) {
                  onToggleSelect(e);
                } else {
                  handleOpenExternal();
                }
              }}
              className={cn(
                "flex-1 min-w-0 text-sm font-medium text-foreground truncate text-left cursor-pointer rounded",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                !isSelectionActive && "hover:underline"
              )}
            >
              {item.title}
            </button>

            {/* Trailing rail — every slot is persistent ink, no hover-only reveals. */}
            <div className="flex items-center gap-1.5 shrink-0">
              {isItemPR &&
                item.state === "open" &&
                item.ciStatus &&
                (() => {
                  const ciVisual = getPRCIStatusVisual(toGitHubCIStatus(item.ciStatus));
                  const ciTooltip = getPRCIStatusTooltip(toGitHubCIStatus(item.ciStatus));
                  if (!ciVisual || !ciTooltip) return null;
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(RAIL_SLOT, "w-3.5 h-3.5")}
                          role="img"
                          aria-label={ciTooltip}
                        >
                          {ciVisual.kind === "icon" ? (
                            <ciVisual.Icon className={cn("w-3.5 h-3.5", ciVisual.colorClass)} />
                          ) : (
                            <span
                              className={cn("block w-2 h-2 rounded-full", ciVisual.colorClass)}
                            />
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{ciTooltip}</TooltipContent>
                    </Tooltip>
                  );
                })()}

              {firstAssignee && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={cn(RAIL_SLOT, "relative")}>
                      <Avatar
                        src={firstAssignee.avatarUrl ?? ""}
                        alt={firstAssignee.login}
                        className="w-4 h-4"
                      />
                      {restAssignees.length > 0 && (
                        <span className="ml-0.5 text-3xs text-text-secondary tabular-nums">
                          +{restAssignees.length}
                        </span>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {restAssignees.length > 0
                      ? `Assigned to ${assignees.map((a) => a.login).join(", ")}`
                      : `Assigned to ${firstAssignee.login}`}
                  </TooltipContent>
                </Tooltip>
              )}

              {hasWorktree && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        RAIL_SLOT,
                        "w-3.5 h-3.5",
                        isActiveWorktree
                          ? // The one place a status colour is load-bearing in
                            // this row: this is the worktree you are standing
                            // in. Colour carries it alone — a border drawn a
                            // hair off a 14px glyph reads as a broken chip, not
                            // as emphasis. Forced-colors strips the hue, so the
                            // distinction moves to `Highlight` there, which is
                            // the one system colour that survives it.
                            "text-status-info forced-colors:text-[color:Highlight]"
                          : "text-text-secondary"
                      )}
                      role="img"
                      aria-label={worktreeTooltip}
                    >
                      <FolderGit2 className="w-3.5 h-3.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{worktreeTooltip}</TooltipContent>
                </Tooltip>
              )}

              <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    /* Stable id so the grid can open this menu from the
                       keyboard (Shift+F10) while DOM focus stays in the search
                       input — otherwise these commands would be pointer-only. */
                    id={menuTriggerId}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      RAIL_SLOT,
                      // Persistent, not hover-revealed — a control that only
                      // exists on hover is a control most people never find.
                      // Emphasis comes from the secondary ink, not from an
                      // opacity wash: 55% put it under the 3:1 floor a
                      // graphical control has to clear.
                      "w-6 h-6 -me-1 rounded text-text-secondary",
                      "hover:bg-overlay-medium hover:text-text-primary",
                      "transition-[background-color,color] duration-150 ease-out",
                      "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                    aria-label={`Actions for #${item.number}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="bottom"
                  align="end"
                  /* Radix restores focus to the trigger, which is `tabIndex={-1}`
                     and not where this widget keeps focus. Hand it back to the
                     search input, which is the grid's real focus holder. */
                  onCloseAutoFocus={(e: Event) => {
                    if (!onMenuClose) return;
                    e.preventDefault();
                    onMenuClose();
                  }}
                  /* The menu portals out of the dropdown's DOM, so without
                     these `FixedDropdown` reads a click on "Copy number" as an
                     outside click and closes the panel out from under the
                     feedback. Same guard the sort popover carries. */
                  onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
                  onTouchStart={(e: React.TouchEvent) => e.stopPropagation()}
                >
                  <DropdownMenuItem onSelect={() => handleOpenExternal()}>
                    <ExternalLink className="h-3.5 w-3.5 mr-2" />
                    Open on GitHub
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleCopyNumber()}>
                    <Copy className="h-3.5 w-3.5 mr-2" />
                    Copy number
                  </DropdownMenuItem>
                  {!isItemPR && "linkedPR" in item && item.linkedPR && (
                    <DropdownMenuItem onSelect={() => handleOpenLinkedPR()}>
                      <GitPullRequest className="h-3.5 w-3.5 mr-2" />
                      Open pull request #{item.linkedPR.number}
                    </DropdownMenuItem>
                  )}

                  {hasWorktree && !isActiveWorktree && onSwitchToWorktree && matchedWorktree && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onSwitchToWorktree(matchedWorktree.id)}>
                        <FolderGit2 className="h-3.5 w-3.5 mr-2" />
                        Switch to worktree
                      </DropdownMenuItem>
                    </>
                  )}

                  {!hasWorktree && onCreateWorktree && item.state === "open" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onCreateWorktree(item)}>
                        <FolderGit2 className="h-3.5 w-3.5 mr-2" />
                        Create worktree
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Metadata line: identity first, then recency, then one label + count. */}
          <div className="flex items-center gap-1.5 mt-1 text-xs text-text-secondary flex-nowrap overflow-hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopyNumber();
                  }}
                  className={cn(
                    "shrink-0 inline-flex items-center tabular-nums rounded cursor-pointer",
                    "hover:text-text-primary transition-colors duration-150 ease-out",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                    copied && "text-status-success"
                  )}
                  aria-label={`Copy number ${item.number}`}
                >
                  {/* No gap between the sigil and the digits — the old
                      `gap-0.5` rendered every row as "# 11958". */}
                  {copied ? (
                    <Check className="w-3 h-3 me-0.5 text-status-success" aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true">#</span>
                  )}
                  <span>{item.number}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{copied ? "Copied" : "Copy number"}</TooltipContent>
            </Tooltip>

            <span className="shrink-0">&middot;</span>
            <span className="truncate max-w-[110px]">{item.author?.login ?? "unknown"}</span>
            <span className="shrink-0">&middot;</span>
            <span className="whitespace-nowrap shrink-0">{formatTimeAgo(item.updatedAt)}</span>

            {(item.commentCount ?? 0) >= 1 && (
              <>
                <span className="shrink-0">&middot;</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-0.5 shrink-0 tabular-nums">
                      <MessageSquare className="w-3 h-3" aria-hidden="true" />
                      <span>{item.commentCount}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {item.commentCount === 1 ? "1 comment" : `${item.commentCount} comments`}
                  </TooltipContent>
                </Tooltip>
              </>
            )}

            {isItemPR && item.headRef && (
              <>
                <span className="shrink-0">&middot;</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate max-w-[150px]">{item.headRef}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {item.headRef} &rarr; {item.baseRef}
                  </TooltipContent>
                </Tooltip>
              </>
            )}

            {!isItemPR && "linkedPR" in item && item.linkedPR && (
              <>
                <span className="shrink-0">&middot;</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenLinkedPR();
                      }}
                      className={cn(
                        "shrink-0 inline-flex items-center gap-0.5 tabular-nums rounded cursor-pointer",
                        "hover:text-text-primary transition-colors duration-150 ease-out",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      )}
                      aria-label={`Open linked pull request #${item.linkedPR.number}`}
                    >
                      <GitPullRequest className="w-3 h-3" aria-hidden="true" />
                      <span>{item.linkedPR.number}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Linked pull request #{item.linkedPR.number}
                  </TooltipContent>
                </Tooltip>
              </>
            )}

            {firstLabel && (
              <>
                <span className="shrink-0">&middot;</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* One complete label plus a count. A label clipped to
                        "enhanceme…" reads as broken data, and the labels past
                        the second used to vanish with nothing to say so. */}
                    <span className="inline-flex items-center gap-1 min-w-0">
                      {firstLabel.color ? (
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: `#${firstLabel.color}` }}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="truncate max-w-[130px]">{firstLabel.name}</span>
                      {restLabels.length > 0 && (
                        <span className="shrink-0 tabular-nums">+{restLabels.length}</span>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {issueLabels.map((l) => l.name).join(", ")}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
