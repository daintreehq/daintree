import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
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
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={ariaLabel}
          title="More options"
          className="shrink-0"
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      {/* `start`: the trigger sits at the left of a banner's control row, and
          an end-aligned menu hangs off the pane's left edge. */}
      <PopoverContent align="start" sideOffset={4} className="flex flex-col p-1 min-w-44">
        {actions.map((item) => {
          const isDanger = item.variant === "danger" || item.variant === "dangerFilled";
          const isDisabled = item.disabled || item.loading;
          return (
            <Button
              key={item.id}
              variant={isDanger ? "ghost-danger" : "ghost"}
              size="sm"
              disabled={isDisabled}
              loading={item.loading}
              aria-label={item.ariaLabel}
              onClick={() => {
                if (isDisabled) return;
                setOpen(false);
                item.onClick();
              }}
              className="w-full justify-start"
            >
              {item.icon && <item.icon aria-hidden="true" />}
              {item.label}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
