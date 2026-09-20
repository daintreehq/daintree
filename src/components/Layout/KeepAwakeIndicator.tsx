import { useLayoutEffect, useRef } from "react";
import { Coffee } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";

/**
 * Daintree is holding the power save blocker (#12516). Neither agent state nor
 * the blocker is otherwise visible, and a terminal stuck on a false "working"
 * would keep the machine up with nothing running, so the hold itself is shown.
 *
 * Tier-1 ambient: a neutral icon with no pip or accent, since holding is the
 * setting doing what it says. It lives in the sidebar footer's status cluster
 * rather than the toolbar: it comes and goes with every agent turn, and there
 * it can do so without moving a button or holding an empty slot open.
 */
export function KeepAwakeIndicator() {
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The hold ends on its own schedule, so this can unmount under a keyboard
  // user. Hand focus to the readout beside it rather than dropping it to the
  // body; focus that already moved on (into Settings, say) is left alone.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (button === null || document.activeElement !== button) return;
      button
        .closest("[data-sidebar-status-bar]")
        ?.querySelector<HTMLElement>("[data-status-readout]")
        ?.focus();
    };
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon-xs"
          data-testid="keep-awake-indicator"
          onClick={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "general", subtab: "overview", sectionId: "general-keep-awake" },
              { source: "user" }
            )
          }
          aria-label="Keeping this machine awake, open keep-awake settings"
        >
          <Coffee aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Keeping this machine awake</span>
          <span>
            Idle sleep is held off while an agent is working. The display can still turn off.
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
