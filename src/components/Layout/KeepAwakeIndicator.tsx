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
 * setting doing what it says. Fixed chrome rather than a registry button, like
 * the memory pause beside it — it only exists while the hold does.
 */
/**
 * Holds the indicator's footprint while keep-awake is on but not holding, so
 * the buttons to its left don't move every time an agent starts or stops
 * working. No `data-toolbar-item`: it must stay out of the roving tab order.
 */
export function KeepAwakeIndicatorPlaceholder() {
  return (
    <div className="toolbar-icon-button h-8 w-8 opacity-0 pointer-events-none" aria-hidden="true" />
  );
}

export function KeepAwakeIndicator() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-toolbar-item=""
          data-testid="keep-awake-indicator"
          onClick={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "general", subtab: "overview", sectionId: "general-keep-awake" },
              { source: "user" }
            )
          }
          className="toolbar-icon-button text-text-secondary"
          aria-label="Keeping this machine awake, open keep-awake settings"
        >
          <Coffee aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
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
