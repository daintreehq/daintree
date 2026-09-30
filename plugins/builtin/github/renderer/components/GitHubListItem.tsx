import { useState, useRef, useEffect, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  Avatar,
  Checkbox,
  DropdownMenu,
  Icon,
  Tooltip,
  type DropdownMenuEntry,
} from "@daintreehq/plugin-ui";
import { avatarUrlAtSize } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type { ForgeLabel, Issue, PR } from "@shared/types/forge";
import type { Worktree } from "@shared/types/worktree";
import { getPRStatusVisual, getPRStatusTooltip } from "../utils/prCIStatus";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  RAIL_SLOT,
  RESOURCE_ITEM_HEIGHT_PX,
  RESOURCE_RAIL,
  RESOURCE_RAIL_SLOT,
  RESOURCE_ROW_STATE_MARK,
} from "./GitHubDropdownSkeletons";
import { deriveRowModel, describeWorktree, type ForgeRowPrimaryAction } from "./forgeRowModel";

interface GitHubListItemProps {
  item: Issue | PR;
  type: "issue" | "pr";
  /**
   * The worktree already made for this resource, resolved once by the list
   * rather than rescanned by every mounted row. `undefined` means none.
   */
  worktree?: Worktree;
  /** The worktree the project view is standing in, for the `Current` state. */
  activeWorktreeId?: string | null;
  /** Which timestamp the row shows, so it agrees with the panel's sort order. */
  timeField?: "created" | "updated";
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
  /** Moves the list's cursor here on real pointer movement, so pointer and keys share one row. */
  onPointerActivate?: () => void;
  isSelected?: boolean;
  isSelectionActive?: boolean;
  /** Widened past `MouseEvent` so the actions menu can run the same command. */
  onToggleSelect?: (e: { shiftKey: boolean }) => void;
}

function StateGlyph({
  state,
  type,
  isDraft,
}: {
  state: string;
  type: "issue" | "pr";
  isDraft?: boolean;
}) {
  if (type === "issue") {
    return <Icon name={state === "open" ? "circle-dot" : "circle-check"} className="h-4 w-4" />;
  }
  // The PR half of this map now lives in `@/lib/prStateGlyph`, because the two
  // PR badges in `src/` were each carrying their own colour-only version of it.
  const PrGlyph = getPrStateGlyph(state, isDraft);
  return <PrGlyph className="h-4 w-4" />;
}

const getStateColor = getPrStateColor;

/**
 * The state glyph's name. It carried none, so a draft PR — whose whole
 * distinction from an open one is that glyph — was indistinguishable to a
 * screen reader from the PR beside it.
 */
function getStateLabel(state: string, type: "issue" | "pr", isDraft?: boolean): string {
  if (type === "issue") return state === "open" ? "Open issue" : "Closed issue";
  if (state === "merged") return "Merged pull request";
  if (state === "open") return isDraft ? "Draft pull request" : "Open pull request";
  return "Closed pull request";
}

function isPR(item: Issue | PR): item is PR {
  return "isDraft" in item;
}

export function GitHubListItem({
  item,
  type,
  worktree,
  activeWorktreeId = null,
  timeField = "updated",
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
  onPointerActivate,
  isSelected = false,
  isSelectionActive = false,
  onToggleSelect,
}: GitHubListItemProps) {
  const isItemPR = isPR(item);
  const stateColor = getStateColor(item.state, isItemPR && item.isDraft);
  const stateLabel = getStateLabel(item.state, type, isItemPR && item.isDraft);

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

  const rowModel = deriveRowModel(item, worktree, activeWorktreeId);
  const { isActiveWorktree } = rowModel;
  /**
   * What this row can actually do, as wired.
   *
   * The model says what the row MEANS to do; a caller that did not pass the
   * handler for it cannot. Falling back to the forge keeps every row doing
   * something — optional-chaining the call instead would leave a row that
   * looks activatable, promises an action in its accessible name, and then
   * silently does nothing.
   */
  const primaryAction: ForgeRowPrimaryAction =
    (rowModel.primaryAction.kind === "switch" && !onSwitchToWorktree) ||
    (rowModel.primaryAction.kind === "create" && !onCreateWorktree)
      ? { kind: "open" }
      : rowModel.primaryAction;
  const worktreeDescription = worktree ? describeWorktree(worktree, isActiveWorktree) : null;

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
      useAnnouncerStore.getState().announce("Copied", "polite");
      setCopied(true);
      copyTimeoutRef.current = window.setTimeout(
        () => setCopied(false),
        UI_ACTION_SUCCESS_DWELL_MS
      );
    } catch {
      // The clipboard can refuse (permissions, a headless context). Say so
      // rather than flashing a success tick for a copy that did not happen.
      setCopied(false);
      console.warn(`Could not copy #${item.number} to the clipboard`);
    }
  };

  /**
   * The row's action: continue this work in Daintree.
   *
   * The row splits its surface deliberately. The title is the resource's name,
   * and a name takes you to where the resource lives, so it opens the forge.
   * Everything else is the row as a place to work, so it switches to the
   * worktree or makes one. The same derivation runs for Enter in the list
   * shell, which also keeps Cmd/Ctrl+Enter for the forge.
   */
  const runPrimaryAction = () => {
    switch (primaryAction.kind) {
      case "switch":
        onSwitchToWorktree?.(primaryAction.worktreeId);
        break;
      case "create":
        onCreateWorktree?.(item);
        break;
      case "open":
        handleOpenExternal();
        break;
    }
  };

  /**
   * What a screen reader is told the row's own action will do, since no
   * tooltip here is reachable.
   *
   * Named for the key rather than "activate": the title inside the row is a
   * control of its own now, so an instruction to activate something would not
   * say which of the two it meant.
   */
  const primaryActionHint =
    primaryAction.kind === "switch"
      ? isActiveWorktree
        ? "Press Enter to return to this worktree"
        : "Press Enter to switch to this worktree"
      : primaryAction.kind === "create"
        ? "Press Enter to create a worktree"
        : "Press Enter to open on GitHub";

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
  const assigneeLabel = firstAssignee
    ? `Assigned to ${assignees.map((a) => a.login).join(", ")}`
    : null;

  const linkedPR = !isItemPR && "linkedPR" in item ? item.linkedPR : undefined;

  // The row's own action leads. It used to sit below a separator under "Open
  // on GitHub", which contradicted what the row actually does when you
  // activate it. The shortcuts are the keys the search field answers to for
  // this row, so the menu teaches them; Enter opens the forge only when the row
  // has nothing local to do.
  const menuItems: DropdownMenuEntry[] = [];
  if (primaryAction.kind === "switch" && onSwitchToWorktree && !isActiveWorktree) {
    const worktreeId = primaryAction.worktreeId;
    menuItems.push({
      label: "Switch to worktree",
      icon: "worktree",
      shortcut: "Enter",
      onSelect: () => onSwitchToWorktree(worktreeId),
    });
  }
  if (primaryAction.kind === "create" && onCreateWorktree) {
    menuItems.push({
      label: "Create worktree",
      icon: "worktree",
      shortcut: "Enter",
      onSelect: () => onCreateWorktree(item),
    });
  }
  menuItems.push(
    {
      label: "Open on GitHub",
      icon: "external-link",
      shortcut: primaryAction.kind === "open" ? "Enter" : "Cmd+Enter",
      onSelect: () => handleOpenExternal(),
    },
    { label: "Copy number", icon: "copy", onSelect: () => void handleCopyNumber() }
  );
  if (linkedPR) {
    menuItems.push({
      label: `Open pull request #${linkedPR.number}`,
      icon: "git-pull-request",
      onSelect: () => handleOpenLinkedPR(),
    });
  }
  // Selection's only accessible, non-hover entry point. The checkbox on the
  // state icon is a pointer shortcut for the same command, not the way you are
  // meant to find it.
  if (onToggleSelect) {
    menuItems.push(
      { type: "separator" },
      {
        label: isSelected ? "Deselect" : "Select",
        icon: "list-checks",
        shortcut: "Shift+Space",
        onSelect: () => onToggleSelect({ shiftKey: false }),
      }
    );
  }
  // A conflict only blocks an open PR; a closed or merged one keeps its last CI word.
  const linkedPRCIVisual = linkedPR
    ? getPRStatusVisual(
        linkedPR.ciStatus,
        linkedPR.state === "open" ? linkedPR.mergeState : undefined
      )
    : null;

  /**
   * Only the review decisions that change what you do next.
   *
   * `REVIEW_REQUIRED` is the resting state of nearly every open PR, so putting
   * it on the surface would print a word on almost every row to say nothing
   * had happened yet. Approval and a change request are events; the absence of
   * a decision is not.
   */
  const reviewDecision = isItemPR ? item.reviewDecision : undefined;
  const reviewVisual: { glyph: ReactNode; label: string; colorClass: string } | null =
    reviewDecision === "CHANGES_REQUESTED"
      ? {
          glyph: <CircleAlert className="w-3 h-3" aria-hidden="true" />,
          label: "Changes requested",
          colorClass: "text-status-warning",
        }
      : reviewDecision === "APPROVED"
        ? {
            glyph: <Icon name="circle-check" className="w-3 h-3" />,
            label: "Approved",
            colorClass: "text-status-success",
          }
        : null;

  const timestamp = timeField === "created" ? item.createdAt : item.updatedAt;
  const timeLabel = `${timeField === "created" ? "Created" : "Updated"} ${new Date(timestamp).toLocaleString()}`;

  return (
    <div
      id={optionId}
      /* A row, not an option. `option` admits no interactive descendants, and
         these rows genuinely carry them — a number that copies, a linked-PR
         jump, an actions menu. The APG's editable-combobox-with-grid-popup
         pattern is the one that models this honestly: the input keeps DOM
         focus and points `aria-activedescendant` at a row, and every control
         lives inside a legal `gridcell`. */
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
        // The app's highlighted-row fill, on the one row the pointer or the
        // arrow keys last put the cursor on — keyed on `isActive` rather than
        // `aria-selected`, which this grid spends on membership. Membership is
        // the filled checkbox and nothing else: a second fill would sit a step
        // away from the cursor's and the two would be read as one another. No
        // accent anywhere (the search field owns the one focus anchor here).
        isActive && "bg-overlay-highlight"
      )}
      onPointerMove={!isActive ? onPointerActivate : undefined}
      // The row draws to exactly the height Virtuoso lays it out on, so the
      // fill and the hit area cover the whole slot with no unowned strip.
      style={{ height: RESOURCE_ITEM_HEIGHT_PX }}
      onClick={(e) => {
        // No modifier branch here. The title is the pointer's route to the
        // forge; a whole-row Cmd/Ctrl+click would only duplicate it, and it
        // would have to sit ahead of selection to be consistent — which turns
        // a stray modifier during a multi-select into a browser launch that
        // dismisses the dropdown. Cmd/Ctrl+Enter stays: the keyboard cursor
        // addresses a whole row and has no title to aim at.
        if (isSelectionActive && onToggleSelect) {
          onToggleSelect(e);
          return;
        }
        runPrimaryAction();
      }}
    >
      <div role="gridcell" className="flex items-start gap-2.5 px-3 py-2.5 h-full">
        {/* The one thing nothing else in the row carries: what activating it
            will do. State and worktree are named by their own elements, so
            repeating them here made the row announce each of them twice. */}
        <span className="sr-only">{primaryActionHint}</span>
        {onToggleSelect ? (
          <span
            data-state-mark
            className={cn("group/icon relative w-4 h-4", RESOURCE_ROW_STATE_MARK)}
          >
            {/* State icon: visible by default, hidden on hover or when selection active */}
            <span
              className={cn(
                "absolute inset-0",
                stateColor,
                isSelectionActive || isSelected ? "hidden" : "group-hover/icon:hidden"
              )}
              role="img"
              aria-label={stateLabel}
            >
              <StateGlyph state={item.state} type={type} isDraft={isItemPR && item.isDraft} />
            </span>
            {/* Checkbox: hidden by default, visible on hover or when selection active.
                Pointer convenience only — the same command is a named item in the
                row's actions menu, so entering selection never depends on hover.
                The shared primitive, not a hand-drawn box: its square corner and
                secondary-ink edge are what stop a 16px mark reading as a radio
                and fading under the 3:1 a control boundary needs. Hidden from
                assistive tech because the row's `aria-selected` already says it. */}
            <Checkbox
              aria-hidden="true"
              tabIndex={-1}
              checked={isSelected}
              // Keeps DOM focus in the search input, as every control in the row does.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleSelect(e);
              }}
              className={cn(
                "absolute inset-0 cursor-pointer",
                isSelectionActive || isSelected ? "flex" : "hidden group-hover/icon:flex"
              )}
            />
          </span>
        ) : (
          <span
            data-state-mark
            className={cn(RESOURCE_ROW_STATE_MARK, stateColor)}
            role="img"
            aria-label={stateLabel}
          >
            <StateGlyph state={item.state} type={type} isDraft={isItemPR && item.isDraft} />
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Title line: the title owns the width; status and actions sit in the rail. */}
          <div className="flex items-center gap-2">
            {/* At 450px most titles truncate. The elaborate tooltips used to
                be on the trivia while the one line you actually need to read
                had none. */}
            <Tooltip content={item.title} side="bottom">
              {/* The title is the resource's own name, so it goes where the
                  resource lives. The row around it is about running the work
                  locally; the text itself is the link out to the forge. */}
              <button
                type="button"
                tabIndex={-1}
                // Chromium focuses a native button on pointer press even at
                // tabIndex -1. This grid keeps DOM focus in the search input
                // and points `aria-activedescendant` at the row, so letting
                // that default through would move focus onto the title and
                // leave the arrow keys — bound to the input — doing nothing.
                // It shows on the selection branch, which keeps the dropdown
                // open after the click rather than navigating away from it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isSelectionActive && onToggleSelect) {
                    onToggleSelect(e);
                    return;
                  }
                  handleOpenExternal();
                }}
                className={cn(
                  "flex-1 min-w-0 text-sm font-medium text-foreground truncate text-left",
                  "cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                  !isSelectionActive && "hover:underline"
                )}
              >
                {item.title}
              </button>
            </Tooltip>

            {/* Trailing rail — every slot is persistent ink, no hover-only reveals.
                Order matters: everything of variable width sits to the LEFT of the
                fixed identity slot, which sits immediately before the always-present
                menu. That is what keeps avatars (and CI glyphs) in one column down
                the list instead of sliding left whenever a neighbour appears. */}
            <div data-rail className={RESOURCE_RAIL}>
              {restAssignees.length > 0 && (
                <span
                  data-rail-slot="count"
                  className="shrink-0 text-3xs text-text-secondary tabular-nums"
                  aria-hidden="true"
                >
                  +{restAssignees.length}
                </span>
              )}

              {isItemPR &&
                item.state === "open" &&
                (item.ciStatus || item.mergeState) &&
                (() => {
                  const ciVisual = getPRStatusVisual(item.ciStatus, item.mergeState);
                  const ciTooltip = getPRStatusTooltip(item.ciStatus, item.mergeState);
                  if (!ciVisual || !ciTooltip) return null;
                  return (
                    <Tooltip content={ciTooltip} side="bottom">
                      <span
                        data-rail-slot="ci"
                        className={cn(RAIL_SLOT, RESOURCE_RAIL_SLOT.ci.box)}
                        role="img"
                        aria-label={ciTooltip}
                      >
                        {ciVisual.kind === "icon" ? (
                          <Icon
                            name={ciVisual.icon}
                            className={cn("w-3.5 h-3.5", ciVisual.colorClass)}
                          />
                        ) : (
                          <span
                            className={cn(
                              "status-mark block w-2 h-2 rounded-full",
                              ciVisual.colorClass
                            )}
                          />
                        )}
                      </span>
                    </Tooltip>
                  );
                })()}

              {firstAssignee && assigneeLabel && (
                <Tooltip content={assigneeLabel} side="bottom">
                  <span
                    data-rail-slot="assignee"
                    className={cn(RAIL_SLOT, RESOURCE_RAIL_SLOT.assignee.box)}
                    role="img"
                    aria-label={assigneeLabel}
                  >
                    <Avatar
                      src={avatarUrlAtSize(firstAssignee.avatarUrl, 32)}
                      name={firstAssignee.login}
                      size="xs"
                      decorative
                    />
                  </span>
                </Tooltip>
              )}

              <DropdownMenu
                open={menuOpen}
                onOpenChange={onMenuOpenChange}
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
                /* The menu portals out of the row's DOM but not out of the
                   React tree, so without this a click on any item also runs
                   the row's primary action underneath it — "Copy number"
                   would copy AND switch worktree, and "Select" would toggle
                   and then activate. FixedDropdown already reads a press in
                   a menu opened from inside it as its own. */
                stopPropagation
                items={menuItems}
                trigger={
                  <button
                    type="button"
                    tabIndex={-1}
                    /* Stable id so the grid can open this menu from the
                       keyboard (Shift+F10) while DOM focus stays in the search
                       input — otherwise these commands would be pointer-only. */
                    id={menuTriggerId}
                    data-rail-slot="menu"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      RAIL_SLOT,
                      // Persistent, not hover-revealed — a control that only
                      // exists on hover is a control most people never find.
                      // Emphasis comes from the secondary ink, not from an
                      // opacity wash: 55% put it under the 3:1 floor a
                      // graphical control has to clear.
                      RESOURCE_RAIL_SLOT.menu.box,
                      "rounded-lg text-text-secondary",
                      "hover:bg-overlay-hover hover:text-text-primary",
                      "transition-[background-color,color] duration-150 ease-out",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                    )}
                    aria-label={`Actions for #${item.number}`}
                  >
                    <Icon name="more-horizontal" className="h-3.5 w-3.5" />
                  </button>
                }
              />
            </div>
          </div>

          {/* Metadata line: identity, then what is happening locally, then the
              forge's own trail. Local state comes early on purpose — it changes
              what activating the row does, so it must not be the thing that
              falls off the clipped end. */}
          <div className="flex items-center gap-1.5 mt-1 text-xs text-text-secondary flex-nowrap overflow-x-clip">
            <Tooltip content={copied ? "Copied" : "Copy number"} side="bottom">
              <button
                type="button"
                tabIndex={-1}
                // Same reason as the title: a pressed native button takes
                // focus even at tabIndex -1, and the grid's keys live on the
                // search input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleCopyNumber();
                }}
                className={cn(
                  // A 24px-tall hit area without growing the 16px metadata
                  // line, whose height the fixed row depends on.
                  "relative after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']",
                  "shrink-0 inline-flex items-center tabular-nums rounded-lg cursor-pointer",
                  "hover:text-text-primary transition-colors duration-150 ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
                  copied && "text-text-primary"
                )}
                aria-label={`Copy number ${item.number}`}
              >
                {/* No gap between the sigil and the digits — the old
                      `gap-0.5` rendered every row as "# 11958". */}
                {copied ? (
                  <Icon name="check" className="w-3 h-3 me-0.5" />
                ) : (
                  <span aria-hidden="true">#</span>
                )}
                <span>{item.number}</span>
              </button>
            </Tooltip>

            {worktree && worktreeDescription && (
              <Tooltip content={worktreeDescription} side="bottom">
                {/* A word, not a 14px glyph wedged in the rail. This is the
                      one fact on the row that changes what activation does, and
                      in an IDE for running work in worktrees it is the most
                      decision-relevant thing the row knows.

                      It says `Worktree`, never the branch: the match is on
                      resource number, so the local branch can legitimately
                      differ from the PR's head ref. The tooltip and the
                      accessible name carry the real name and branch. */}
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1",
                    isActiveWorktree
                      ? // The one place a status colour is load-bearing in this
                        // row: this is the worktree you are standing in.
                        // Forced-colors strips the hue, so the distinction moves
                        // to `Highlight`, the one system colour that survives it.
                        "text-status-info forced-colors:text-[color:Highlight]"
                      : "text-text-secondary"
                  )}
                  role="img"
                  aria-label={worktreeDescription}
                >
                  <span aria-hidden="true">&middot;</span>
                  <Icon name="worktree" className="w-3 h-3" />
                  <span>{isActiveWorktree ? "Current" : "Worktree"}</span>
                </span>
              </Tooltip>
            )}

            {reviewVisual && (
              <span
                className={cn("shrink-0 inline-flex items-center gap-1", reviewVisual.colorClass)}
                role="img"
                aria-label={`Review: ${reviewVisual.label}`}
              >
                <span aria-hidden="true" className="text-text-secondary">
                  &middot;
                </span>
                {reviewVisual.glyph}
                <span>{reviewVisual.label}</span>
              </span>
            )}

            {/* Separator kept inside the element it belongs to. Every middot
                used to be independently `shrink-0`, so an author name squeezed
                to nothing left its middot behind as a dangling dot. */}
            {/* Whose it is outranks which branch it came from: the head ref
                usually restates the title, so it is the field that yields.
                The author keeps its width up to a cap instead of shrinking in
                step with the ref, which cut every PR author to "gre…". */}
            <span className="inline-flex items-center gap-1.5 shrink-0 max-w-[120px]">
              <span className="shrink-0" aria-hidden="true">
                &middot;
              </span>
              <Tooltip content={item.author?.login ?? "unknown"} side="bottom">
                <span className="truncate">{item.author?.login ?? "unknown"}</span>
              </Tooltip>
            </span>

            <span className="shrink-0" aria-hidden="true">
              &middot;
            </span>
            {/* Which timestamp this is depends on the panel's sort order —
                showing "updated" under a "Newest" sort made the ages read out
                of order against the list they were sorting. */}
            <Tooltip content={timeLabel} side="bottom">
              <span className="whitespace-nowrap shrink-0" role="img" aria-label={timeLabel}>
                {formatTimeAgo(timestamp)}
              </span>
            </Tooltip>

            {(item.commentCount ?? 0) >= 1 && (
              <>
                <span className="shrink-0" aria-hidden="true">
                  &middot;
                </span>
                <Tooltip
                  content={item.commentCount === 1 ? "1 comment" : `${item.commentCount} comments`}
                  side="bottom"
                >
                  <span
                    className="inline-flex items-center gap-0.5 shrink-0 tabular-nums"
                    role="img"
                    aria-label={
                      item.commentCount === 1 ? "1 comment" : `${item.commentCount} comments`
                    }
                  >
                    <Icon name="message-square" className="w-3 h-3" />
                    <span aria-hidden="true">{item.commentCount}</span>
                  </span>
                </Tooltip>
              </>
            )}

            {isItemPR && item.headRef && (
              <Tooltip
                content={
                  <>
                    {item.headRef} &rarr; {item.baseRef}
                  </>
                }
                side="bottom"
              >
                <span
                  className="inline-flex items-center gap-1.5 min-w-0"
                  role="img"
                  aria-label={`Merges ${item.headRef} into ${item.baseRef}`}
                >
                  <span className="shrink-0" aria-hidden="true">
                    &middot;
                  </span>
                  <span className="truncate max-w-[150px]" aria-hidden="true">
                    {item.headRef}
                  </span>
                </span>
              </Tooltip>
            )}

            {linkedPR && (
              <>
                <span className="shrink-0" aria-hidden="true">
                  &middot;
                </span>
                <Tooltip
                  content={
                    <>
                      Pull request #{linkedPR.number} &middot; {linkedPR.state}
                      {linkedPRCIVisual ? ` · ${linkedPRCIVisual.ariaLabel}` : ""}
                    </>
                  }
                  side="bottom"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenLinkedPR();
                    }}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-0.5 tabular-nums rounded-lg cursor-pointer",
                      "hover:text-text-primary transition-colors duration-150 ease-out",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                    )}
                    aria-label={
                      // The linked PR's own state and checks arrive with the
                      // issue and used to be thrown away: a merged linkage and
                      // one with failing checks rendered identically.
                      `Open linked pull request #${linkedPR.number} (${linkedPR.state}${
                        linkedPRCIVisual ? `, ${linkedPRCIVisual.ariaLabel}` : ""
                      })`
                    }
                  >
                    <Icon
                      name="git-pull-request"
                      className={cn("w-3 h-3", getStateColor(linkedPR.state))}
                    />
                    <span>{linkedPR.number}</span>
                    {linkedPRCIVisual &&
                      (linkedPRCIVisual.kind === "icon" ? (
                        <Icon
                          name={linkedPRCIVisual.icon}
                          className={cn("w-3 h-3 ms-0.5", linkedPRCIVisual.colorClass)}
                        />
                      ) : (
                        <span
                          className={cn(
                            "status-mark block w-1.5 h-1.5 rounded-full ms-0.5",
                            linkedPRCIVisual.colorClass
                          )}
                          aria-hidden="true"
                        />
                      ))}
                  </button>
                </Tooltip>
              </>
            )}

            {firstLabel && (
              <Tooltip content={issueLabels.map((l) => l.name).join(", ")} side="bottom">
                {/* One complete label plus a count. A label clipped to
                      "enhanceme…" reads as broken data, and the labels past
                      the second used to vanish with nothing to say so. */}
                <span
                  className="inline-flex items-center gap-1 min-w-0"
                  role="img"
                  aria-label={`Labels: ${issueLabels.map((l) => l.name).join(", ")}`}
                >
                  <span className="shrink-0" aria-hidden="true">
                    &middot;
                  </span>
                  {firstLabel.color ? (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: `#${firstLabel.color}` }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="truncate max-w-[130px]" aria-hidden="true">
                    {firstLabel.name}
                  </span>
                  {restLabels.length > 0 && (
                    <span className="shrink-0 tabular-nums" aria-hidden="true">
                      +{restLabels.length}
                    </span>
                  )}
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
