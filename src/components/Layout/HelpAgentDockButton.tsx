import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { useFocusStore } from "@/store/focusStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { useMcpReadiness } from "@/hooks/useMcpReadiness";
import type { McpRuntimeSnapshot } from "@shared/types";

interface PipDescriptor {
  className: string;
  // Whether to gate the pip behind the 400ms Doherty anti-flicker (transient
  // states only — failures should appear immediately).
  delayed: boolean;
  tooltip: string;
}

function describePip(snapshot: McpRuntimeSnapshot): PipDescriptor | null {
  switch (snapshot.state) {
    case "starting":
      return {
        className: "bg-status-warning",
        delayed: true,
        tooltip: "MCP starting…",
      };
    case "failed":
      return {
        className: "bg-status-danger",
        delayed: false,
        tooltip: snapshot.lastError ?? "MCP failed to start",
      };
    case "ready":
    case "disabled":
    default:
      // Healthy state: no pip. Per the design rules we never render an
      // "all clear" indicator — it's just visual noise when MCP is fine
      // 99.9% of the time. Disabled state likewise has no pip; a user who
      // turned daintreeControl off doesn't need a status marker.
      return null;
  }
}

export function HelpAgentDockButton() {
  const isOpen = useHelpPanelStore((s) => s.isOpen);
  const toggle = useHelpPanelStore((s) => s.toggle);
  const mcp = useMcpReadiness();

  const handleClick = useCallback(() => {
    suppressSidebarResizes();
    // Explicit toggle takes ownership of the assistant's visibility — clear
    // any lingering gesture suppression so the next visible state matches
    // the toggle's intent rather than staying width=0 behind the gesture.
    useFocusStore.getState().clearAssistantGesture();
    toggle();
  }, [toggle]);

  const pip = describePip(mcp);
  const baseTooltip = isOpen ? "Close Daintree Assistant" : "Open Daintree Assistant";
  // Fold pip state into the accessible name so screen-reader users hear the
  // status change. The visible tooltip mirrors this; the pip itself is
  // aria-hidden to avoid a duplicate announcement.
  const ariaLabel = pip ? `Daintree Assistant — ${pip.tooltip}` : "Daintree Assistant";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pill"
          size="sm"
          className={cn("relative px-2", isOpen && "bg-overlay-emphasis border-border-default")}
          onClick={handleClick}
          aria-label={ariaLabel}
          aria-expanded={isOpen}
        >
          <DaintreeIcon className="w-3.5 h-3.5 text-daintree-text/50" />
          {pip && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-daintree-bg",
                pip.className,
                // Anti-flicker only for transient states — failures must be
                // visible immediately. CSS handles the 400ms delay.
                pip.delayed && "animate-pulse-delayed"
              )}
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {pip ? `${baseTooltip} — ${pip.tooltip}` : baseTooltip}
      </TooltipContent>
    </Tooltip>
  );
}
