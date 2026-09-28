import type * as React from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * options behind a `⋯` trigger — the same menu every other `⋯` trigger in the
 * app opens. Renders nothing when there are no overflow actions.
 */
export function BannerOverflowMenu({
  actions,
  ariaLabel = "More options",
}: BannerOverflowMenuProps) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={ariaLabel} className="shrink-0">
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">More options</TooltipContent>
      </Tooltip>
      {/* `start`: the trigger sits at the left of a banner's control row, and
          an end-aligned menu hangs off the pane's left edge. */}
      <DropdownMenuContent align="start" className="min-w-44">
        {actions.map((item) => {
          const isDanger = item.variant === "danger" || item.variant === "dangerFilled";
          // Lucide icons forward any SVG attribute; the banner type only names className.
          const Icon = item.icon as React.ComponentType<React.SVGProps<SVGSVGElement>> | undefined;
          return (
            <DropdownMenuItem
              key={item.id}
              destructive={isDanger}
              disabled={item.disabled || item.loading}
              aria-label={item.ariaLabel}
              aria-busy={item.loading || undefined}
              onSelect={() => item.onClick()}
            >
              {item.loading ? (
                <span data-menu-icon className="mr-2 flex h-3.5 w-3.5 items-center justify-center">
                  <Spinner size="xs" />
                </span>
              ) : (
                Icon && <Icon data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              )}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
