import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { BannerAction } from "./InlineStatusBanner";

interface BannerOverflowMenuProps {
  /** Secondary affordances demoted out of the banner's single primary action. */
  actions: BannerAction[];
  /** Accessible label for the trigger. Defaults to "More options". */
  ariaLabel?: string;
}

/**
 * Overflow menu for an inline banner's secondary affordances. Rendered in the
 * banner's `trailingSlot`, it keeps the banner to a single primary `action`
 * (CLAUDE.md Title-Message-Action) while still surfacing the demoted recovery
 * options behind a `⋯` trigger — the same shape `SafeModeBanner` uses for its
 * details popover. Renders nothing when there are no overflow actions.
 */
export function BannerOverflowMenu({
  actions,
  ariaLabel = "More options",
}: BannerOverflowMenuProps) {
  const [open, setOpen] = useState(false);

  if (actions.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={ariaLabel}
        title="More options"
        className="p-1 rounded text-daintree-text/60 hover:text-text-primary hover:bg-daintree-border/50 transition-colors outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary shrink-0"
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="p-1 min-w-44 text-xs">
        {actions.map((item) => {
          const isDanger = item.variant === "danger" || item.variant === "dangerFilled";
          const isDisabled = item.disabled || item.loading;
          return (
            <button
              key={item.id}
              type="button"
              disabled={isDisabled}
              aria-busy={item.loading || undefined}
              aria-label={item.ariaLabel}
              onClick={() => {
                if (isDisabled) return;
                setOpen(false);
                item.onClick();
              }}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors",
                "outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary",
                isDanger
                  ? "text-status-error hover:bg-status-error/10"
                  : "text-text-primary hover:bg-daintree-border/50",
                isDisabled && "cursor-not-allowed opacity-60 hover:bg-transparent"
              )}
            >
              {item.icon && <item.icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
              {item.label}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
