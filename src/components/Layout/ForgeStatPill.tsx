import type React from "react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatForgeBadgeCount } from "./forgeStatsCountDisplay";

export interface ForgeStatPillProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  count: number | null;
  /**
   * Pre-formatted value to render in the badge when it should differ from the
   * raw `count` — e.g. `"20+"` when the dropdown has loaded a first page but
   * more items exist. `count` stays numeric for the digit-pulse animation
   * delta comparisons; this is display-only. Falls back to `count` when unset.
   */
  displayCount?: number | string | null;
  animKey: number;
  ariaLabel: string;
  testId?: string;
  tooltipContent: React.ReactNode;
  /**
   * Hold the hover tooltip shut — while a callout already points at this
   * pill, a second bubble under it would cover the first.
   */
  tooltipSuppressed?: boolean;
  ariaDescribedBy?: string;
  /**
   * This pill's own right-click menu. Each segment owns one so it can lead
   * with its own navigation — a single menu around the whole stats control
   * can't tell which segment was clicked (#12354).
   */
  contextMenuContent: React.ReactNode;
  onContextMenuOpenChange?: (open: boolean) => void;

  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  /**
   * `quiet` — a genuine zero: the numeral steps down to secondary text while
   * the icon keeps its forge colour. `unavailable` — no count to show (token
   * missing): icon and dash both secondary. Never whole-button opacity, which
   * dimmed the focus ring and hover with it and made the token-repair click
   * look disabled.
   */
  tone?: "default" | "quiet" | "unavailable";
  className?: string;

  dropdownContent: React.ReactNode;
  persistThroughChildOverlays?: boolean;
  keepMounted?: boolean;

  onClick: () => void;
  onOpenChange: (open: boolean) => void;
  onPointerEnter?: (e: React.PointerEvent) => void;
  onPointerLeave?: (e: React.PointerEvent) => void;

  /**
   * The count rose recently: the strip's neutral round pip on the glyph, the
   * same mark the bell wears for unread. The name says it in words.
   */
  activity?: boolean;
  /**
   * False when the click goes somewhere else (Settings to repair a token, the
   * forge's website) instead of opening this segment's panel, so the button
   * claims no expanded state it can never reach.
   */
  hasDisclosure?: boolean;
}

export function ForgeStatPill({
  buttonRef,
  open,
  count,
  displayCount,
  animKey,
  ariaLabel,
  testId,
  tooltipContent,
  tooltipSuppressed = false,
  ariaDescribedBy,
  contextMenuContent,
  onContextMenuOpenChange,
  icon: Icon,
  iconClassName,
  tone = "default",
  className,
  dropdownContent,
  persistThroughChildOverlays,
  keepMounted,
  onClick,
  onOpenChange,
  onPointerEnter,
  onPointerLeave,
  activity = false,
  hasDisclosure = true,
}: ForgeStatPillProps) {
  // A disclosure, and modelled as one. The panel is non-modal — focus is not
  // trapped, the rest of the app stays reachable — so `dialog` was the wrong
  // shape twice over: it promises modality this panel does not have, and a
  // `keepMounted` dropdown leaves that dialog permanently in the tree, where it
  // collided with the app's real modals (Settings stopped opening from this
  // pill entirely). A `region` labelled by its own trigger says what this
  // actually is, and only exists while it is open.
  const dropdownId = useId();
  const triggerId = useId();
  // A segment whose click went elsewhere (a token error arriving while its
  // panel was open) shows no panel, so it never stacks under the token callout.
  const panelOpen = hasDisclosure && open;
  return (
    <>
      {/* Held shut while this segment's own panel is open: the tooltip and the
          panel both hang off the segment's bottom edge, and the tooltip would
          land on the panel's header. */}
      <Tooltip open={tooltipSuppressed || panelOpen ? false : undefined}>
        <ContextMenu onOpenChange={onContextMenuOpenChange}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                ref={buttonRef}
                variant="ghost"
                data-toolbar-item=""
                data-stat-segment=""
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
                onClick={onClick}
                className={cn(
                  // Press, transition and the open state's fill and inset edge
                  // all come from toolbar/controls.css, shared with the toolbar's other
                  // controls, and so does the divider, a background line the
                  // fills paint under. The ring is inset: the container's
                  // overflow-hidden clips an outward one.
                  "toolbar-stat-pill relative h-full flex-1 justify-center gap-1.5 rounded-none px-2 text-text-primary hover:bg-[var(--toolbar-stats-hover-bg,var(--toolbar-control-hover-bg,var(--theme-overlay-hover)))] hover:text-text-primary focus-visible:-outline-offset-2",
                  className
                )}
                id={triggerId}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                aria-expanded={hasDisclosure ? open : undefined}
                aria-controls={panelOpen ? dropdownId : undefined}
                data-testid={testId}
              >
                <span className="relative inline-flex">
                  <Icon
                    className={cn(
                      "h-4 w-4",
                      tone === "unavailable" ? "text-text-secondary" : iconClassName
                    )}
                  />
                  <span
                    aria-hidden="true"
                    data-visible={activity}
                    className="toolbar-pip toolbar-badge bg-text-secondary"
                  />
                </span>
                <span
                  key={animKey}
                  data-stat-quiet={tone !== "default" ? "" : undefined}
                  className={cn(
                    "text-xs font-medium tabular-nums",
                    tone !== "default" && "text-text-secondary",
                    animKey > 0 && "animate-badge-bump"
                  )}
                >
                  {/* Unavailable shows the dash even over counts kept from an
                      earlier fetch: the name says the token needs repair, and a
                      number beside it would contradict that. */}
                  {tone === "unavailable"
                    ? "—"
                    : (formatForgeBadgeCount(displayCount ?? count) ?? "—")}
                </span>
              </Button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
            {contextMenuContent}
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
      <FixedDropdown
        open={panelOpen}
        onOpenChange={onOpenChange}
        anchorRef={buttonRef}
        className="p-0 w-[450px]"
        persistThroughChildOverlays={persistThroughChildOverlays}
        keepMounted={keepMounted}
      >
        <div
          id={dropdownId}
          role={panelOpen ? "region" : undefined}
          aria-labelledby={panelOpen ? triggerId : undefined}
          // `keepMounted` keeps this subtree in the DOM between opens. Hidden
          // content that is still reachable by a screen reader's virtual
          // cursor is worse than no content, so it is taken out of the tree
          // and out of the tab order whenever the panel is not open.
          aria-hidden={panelOpen ? undefined : true}
          inert={!panelOpen}
        >
          {dropdownContent}
        </div>
      </FixedDropdown>
    </>
  );
}
