import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "./ErrorBanner";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";

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
  className?: string;
}

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
  className,
  ...handlers
}: CompactErrorListProps) {
  if (errors.length === 0) return null;

  const inline = errors.slice(0, maxInline);
  const hidden = errors.slice(maxInline);

  return (
    // One column of bands, the way every inline banner family stacks. The host
    // decides the outer shape: flush to a pane's edges, or rounded in a card.
    <div className={cn("flex flex-col overflow-hidden", className)}>
      {inline.map((error) => (
        <ErrorBanner key={error.id} error={error} {...handlers} />
      ))}
      {hidden.length > 0 && <ErrorOverflow errors={hidden} {...handlers} />}
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
function ErrorOverflow({ errors, ...handlers }: ErrorListHandlers & { errors: ErrorRecord[] }) {
  const [open, setOpen] = useState(false);
  const label = `Show ${errors.length} more ${errors.length === 1 ? "error" : "errors"}`;

  return (
    <div className="flex border-b border-divider px-3 py-1">
      <Popover open={open} onOpenChange={setOpen}>
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
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label="More errors"
          // A portal moves the DOM but not the React tree, so a row's Retry would
          // still bubble into the card behind it.
          onClick={(e) => e.stopPropagation()}
          // Bounded against Radix's own available height rather than a fixed
          // pixel cap, so a long tail scrolls inside the popover instead of
          // running past the viewport edge. The width is a reading measure, not
          // the trigger's, and never wider than the window can hold.
          className="flex w-96 max-w-[calc(100vw-16px)] flex-col max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        >
          {errors.map((error) => (
            <ErrorBanner key={error.id} error={error} animated={false} {...handlers} />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
