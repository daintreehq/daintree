import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "./ErrorBanner";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getVisibleTabbableElements } from "@/lib/accessibility";
import { sanitizeErrorText } from "@/utils/errorText";
import { BANNER_TINT_ALPHA } from "@shared/config/windowChrome";

/**
 * Errors already announced, across every mount. A list remounts whenever its
 * host does — a worktree card's details reopening, a pane moving — and an
 * error the user heard about an hour ago is not news the second time.
 */
const announced = new Set<string>();
const ANNOUNCED_CAP = 500;

function announceArrivals(errors: ErrorRecord[]) {
  // Restored from the last session: already on screen at launch, not arriving.
  const fresh = errors.filter((e) => !announced.has(e.id) && !e.fromPreviousSession);
  for (const e of errors) announced.add(e.id);
  if (announced.size > ANNOUNCED_CAP) {
    for (const id of [...announced].slice(0, announced.size - ANNOUNCED_CAP)) announced.delete(id);
  }
  if (fresh.length === 0) return;
  const { announce } = useAnnouncerStore.getState();
  announce(
    fresh.length === 1
      ? `Error: ${sanitizeErrorText(fresh[0]!.message)}`
      : `${fresh.length} new errors`,
    "polite"
  );
}

/** Each row is a direct child of the list, or of the open popover. */
const ROW = ":scope > [role='status']";

interface ErrorListHandlers {
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
}

interface CompactErrorListProps extends ErrorListHandlers {
  /** Every error for this surface, newest-first as the caller ordered them. */
  errors: ErrorRecord[];
  /** How many banners render inline before the rest move behind the trigger. */
  maxInline: number;
  /**
   * `flush` meets the host's edges, as a banner does across the top of a pane:
   * every row, the last included, closes with its divider. `inset` sits inside
   * a card's padding: the group is rounded and the last divider goes, since
   * the rounded edge already ends it.
   */
  variant: "flush" | "inset";
  className?: string;
}

/** Rows and the disclosure end on their own divider; an inset group drops the last. */
const INSET = "rounded-[var(--radius-md)] [&>:last-child]:border-b-0!";

/**
 * A bounded stack of compact error banners, with the tail behind a real
 * disclosure.
 *
 * Both surfaces that use this used to cap the stack and print "+N more errors"
 * as inert text: the errors were in memory, their retry and dismiss handlers
 * were already wired, and the count named recovery the user had no way to
 * reach (#12001). The tail now opens, and every hidden row keeps the CTA it
 * would have had inline.
 *
 * Extracted rather than inlined twice because both callers pass the same
 * `ErrorRecord` array and the same three handlers — they differ only in how
 * many banners the surface has room for.
 */
export function CompactErrorList({
  errors,
  maxInline,
  variant,
  className,
  onDismiss,
  ...handlers
}: CompactErrorListProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    announceArrivals(errors);
  }, [errors]);

  // A dismissed row takes its focused × with it. Hand focus to the row that
  // takes its place — the next, else the previous, inline or in the popover —
  // then to the disclosure, then to the host itself, so the user stays where
  // they were working rather than being thrown to the top of the app. Moved
  // before the removal, so the row's own unmount has nothing to recover.
  const handleDismiss = useCallback(
    (id: string) => {
      const active = document.activeElement;
      const rows = [
        ...(rootRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []),
        ...(popoverRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []),
      ];
      const index = active ? rows.findIndex((row) => row.contains(active)) : -1;
      if (index !== -1) {
        const neighbour = [rows[index + 1], rows[index - 1]]
          // A control, not the first tabbable: a clamped message is a tab stop,
          // and focusing it would open its tooltip over the list.
          .map(
            (row) => row && getVisibleTabbableElements(row).find((el) => el.tagName === "BUTTON")
          )
          .find(Boolean);
        const target =
          neighbour ??
          rootRef.current?.querySelector<HTMLElement>("[data-testid='compact-error-overflow']") ??
          rootRef.current?.parentElement?.closest<HTMLElement>("[tabindex]");
        target?.focus({ preventScroll: true });
      }
      onDismiss(id);
    },
    [onDismiss]
  );

  if (errors.length === 0) return null;

  const inline = errors.slice(0, maxInline);
  const hidden = errors.slice(maxInline);
  const rowHandlers = { ...handlers, onDismiss: handleDismiss };

  return (
    // One column of bands, the way every inline banner family stacks. The host
    // decides the outer shape: flush to a pane's edges, or rounded in a card.
    <div
      ref={rootRef}
      className={cn("flex flex-col overflow-hidden", variant === "inset" && INSET, className)}
    >
      {inline.map((error) => (
        <ErrorBanner key={error.id} error={error} {...rowHandlers} />
      ))}
      {hidden.length > 0 && (
        <ErrorOverflow
          errors={hidden}
          anchorRef={rootRef}
          contentRef={popoverRef}
          {...rowHandlers}
        />
      )}
    </div>
  );
}

/**
 * The errors past the inline cap.
 *
 * Mounted only while a tail exists, so `open` dies with it. Holding that state
 * in the parent instead would survive the tail: dismiss the last hidden error
 * while the disclosure is open and a later error would remount it already
 * open, stealing focus from whatever the user moved on to.
 */
function ErrorOverflow({
  errors,
  anchorRef,
  contentRef,
  ...handlers
}: ErrorListHandlers & {
  errors: ErrorRecord[];
  anchorRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  // The hidden rows open at the list's width, starting at its left edge, so
  // every column sits where the inline rows put it. Measured as the popover
  // opens: the trigger is inset from that edge by the row's own padding.
  const [frame, setFrame] = useState<{ width: number; offset: number } | null>(null);
  const handleOpenChange = (next: boolean, trigger?: HTMLElement | null) => {
    const list = anchorRef.current?.getBoundingClientRect();
    const own = trigger?.getBoundingClientRect();
    if (next && list && own) setFrame({ width: list.width, offset: list.left - own.left });
    setOpen(next);
  };
  const label = `Show ${errors.length} more ${errors.length === 1 ? "error" : "errors"}`;

  return (
    // Part of the error group rather than a strip of its own: the same band
    // and divider as the rows above it.
    <div
      className="flex px-3 py-1.5"
      style={{
        backgroundColor: `color-mix(in oklab, var(--color-status-error) ${BANNER_TINT_ALPHA * 100}%, transparent)`,
        borderBottom: "1px solid color-mix(in oklab, var(--color-status-error) 20%, transparent)",
      }}
    >
      <Popover
        open={open}
        onOpenChange={(next) =>
          handleOpenChange(
            next,
            anchorRef.current?.querySelector<HTMLElement>("[data-testid='compact-error-overflow']")
          )
        }
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            data-testid="compact-error-overflow"
            aria-label={label}
            // These banners render inside a click-to-select worktree card, whose
            // root handler would select the card and — from the overview modal —
            // unmount it mid-open, so the disclosure would never appear. Same
            // boundary the card's own overlay controls draw.
            onClick={(e) => e.stopPropagation()}
            // Past the glyph column, so the count reads as part of the list above.
            className="ml-3.5 text-xs"
          >
            {errors.length} more {errors.length === 1 ? "error" : "errors"}
            <ChevronDown
              aria-hidden="true"
              className={cn("transition-transform duration-150", open && "rotate-180")}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          align="start"
          alignOffset={frame?.offset}
          sideOffset={2}
          collisionPadding={8}
          aria-label="More errors"
          // Radix focuses the first tabbable on open, which for a clamped
          // message is the message itself — and focus opens its tooltip over
          // the list. Land on the first row's first control instead.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.querySelector<HTMLElement>("button")?.focus();
          }}
          // A portal moves the DOM but not the React tree, so a row's Retry would
          // still bubble into the card behind it.
          onClick={(e) => e.stopPropagation()}
          // Bounded against Radix's own available height rather than a fixed
          // pixel cap, so a long tail scrolls inside the popover instead of
          // running past the viewport edge. The last row's divider would double
          // the popover's own border.
          style={frame ? { width: frame.width } : undefined}
          className="flex w-96 max-w-[calc(100vw-16px)] flex-col max-h-[var(--radix-popover-content-available-height)] overflow-y-auto [&>:last-child]:border-b-0!"
        >
          {errors.map((error) => (
            <ErrorBanner key={error.id} error={error} animated={false} {...handlers} />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
