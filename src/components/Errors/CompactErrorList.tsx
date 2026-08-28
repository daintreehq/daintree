import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "./ErrorBanner";
import type { ErrorRecord, RetryAction } from "@/store/errorStore";

/* Restated under the variant on purpose: Tailwind v4 compiles the
   outline-suppressing utility to an unconditional `--tw-outline-style: none`,
   which cancels `focus-visible:outline-2` unless the style is set again there.
   Same string `ReadinessRail` uses — the accent appears only as a focus ring,
   which is the one place the accent-restraint rule permits it. */
const FOCUS_RING =
  "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

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
    <div className={cn("space-y-1", className)}>
      {inline.map((error) => (
        <ErrorBanner key={error.id} error={error} compact {...handlers} />
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        data-testid="compact-error-overflow"
        aria-label={label}
        // These banners render inside a click-to-select worktree card, whose
        // root handler would select the card and — from the overview modal —
        // unmount it mid-open, so the disclosure would never appear. Same
        // boundary the card's own overlay controls draw.
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex w-fit mx-auto items-center gap-0.5 px-1.5 py-0.5 rounded text-3xs transition-colors",
          "text-text-secondary hover:text-text-primary hover:bg-tint/[0.06]",
          FOCUS_RING
        )}
      >
        {errors.length} more {errors.length === 1 ? "error" : "errors"}
        <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        aria-label="More errors"
        // A portal moves the DOM but not the React tree, so a row's Retry would
        // still bubble into the card behind it.
        onClick={(e) => e.stopPropagation()}
        // Bounded against Radix's own available height rather than a fixed
        // pixel cap, so a long tail scrolls inside the popover instead of
        // running past the viewport edge.
        className="p-1 min-w-72 max-w-sm max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
      >
        <ul className="flex flex-col gap-1">
          {errors.map((error) => (
            <li key={error.id}>
              <ErrorBanner error={error} compact {...handlers} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
