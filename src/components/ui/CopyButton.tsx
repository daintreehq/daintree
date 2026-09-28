import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";

export interface CopyButtonProps extends Omit<
  ButtonProps,
  "variant" | "size" | "children" | "asChild" | "loading" | "type" | "title"
> {
  /**
   * What lands on the clipboard. A function is read at click time, for a
   * payload too costly to build on every render (a serialised log entry).
   */
  text: string | (() => string);
  /**
   * Constant for the life of the button. It never flips to "Copied": the hook
   * announces the copy through the polite live region, and a name that changes
   * under focus is announced a second time.
   */
  "aria-label": string;
  /** Tooltip text. Defaults to the accessible name. */
  tooltip?: React.ReactNode;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
  /** Polite announcement on success. Defaults to the hook's "Copied". */
  announcement?: string;
}

/**
 * The icon-only copy control: a ghost `icon-xs` button (24px target) with a
 * 14px glyph that swaps to a check for the success dwell.
 *
 * The check is neutral. The glyph swap and the announcement carry the
 * confirmation; green on some copy buttons and not others was the
 * inconsistency this replaced.
 *
 * For a string `text`, the check only shows while `copiedText` is the current
 * value, so a value that changes under the button (a re-rooted path, a new
 * endpoint) never inherits the previous copy's confirmation. `data-copied` is set for the
 * same window, so a hover-revealed caller can hold the button visible while
 * it confirms (`data-copied:opacity-100`).
 *
 * `onClick` runs first; a handler that calls `preventDefault()` cancels the
 * copy, and one that stops propagation keeps the row behind it untouched.
 */
export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ text, tooltip, tooltipSide = "top", announcement, className, onClick, ...props }, ref) => {
    const { copiedText, copy } = useCopyWithFeedback(
      announcement === undefined ? undefined : { announcement }
    );
    const copied = copiedText !== null && (typeof text === "function" || copiedText === text);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="icon-xs"
            className={cn("shrink-0 [&_svg]:size-3.5", className)}
            onClick={(event) => {
              onClick?.(event);
              if (event.defaultPrevented) return;
              void copy(typeof text === "function" ? text() : text);
            }}
            {...props}
            data-copied={copied || undefined}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip ?? props["aria-label"]}</TooltipContent>
      </Tooltip>
    );
  }
);
CopyButton.displayName = "CopyButton";
