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
  "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";

interface CompactErrorListProps {
  /** Every error for this surface, newest-first as the caller ordered them. */
  errors: ErrorRecord[];
  /** How many banners render inline before the rest move behind the trigger. */
  maxInline: number;
  onDismiss: (id: string) => void;
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
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
  onDismiss,
  onRetry,
  onCancelRetry,
  className,
}: CompactErrorListProps) {
  const [open, setOpen] = useState(false);

  if (errors.length === 0) return null;

  const inline = errors.slice(0, maxInline);
  const hidden = errors.slice(maxInline);

  return (
    <div className={cn("space-y-1", className)}>
      {inline.map((error) => (
        <ErrorBanner
          key={error.id}
          error={error}
          onDismiss={onDismiss}
          onRetry={onRetry}
          onCancelRetry={onCancelRetry}
          compact
        />
      ))}

      {hidden.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            type="button"
            data-testid="compact-error-overflow"
            // Spelled out rather than left as a bare count: the trigger has to
            // say what opening it produces, and the messages are what a screen
            // reader needs to decide whether it's worth opening.
            aria-label={`Show ${hidden.length} more ${
              hidden.length === 1 ? "error" : "errors"
            }: ${hidden.map((e) => e.message).join(", ")}`}
            className={cn(
              "flex w-fit mx-auto items-center gap-0.5 px-1.5 py-0.5 rounded text-[0.65rem] transition-colors",
              "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
              FOCUS_RING
            )}
          >
            {hidden.length} more {hidden.length === 1 ? "error" : "errors"}
            <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            align="center"
            sideOffset={8}
            aria-label="More errors"
            // Bounded against Radix's own available height rather than a fixed
            // pixel cap, so a long tail scrolls inside the popover instead of
            // running past the viewport edge.
            className="p-1 min-w-72 max-w-sm max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
          >
            <ul className="flex flex-col gap-1">
              {hidden.map((error) => (
                <li key={error.id}>
                  <ErrorBanner
                    error={error}
                    onDismiss={(id) => {
                      onDismiss(id);
                      // Dismissing the last hidden error leaves an empty
                      // popover anchored to a trigger that is about to
                      // unmount; close on the way out instead.
                      if (hidden.length === 1) setOpen(false);
                    }}
                    onRetry={onRetry}
                    onCancelRetry={onCancelRetry}
                    compact
                  />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
