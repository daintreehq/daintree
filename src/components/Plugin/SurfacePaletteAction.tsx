import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";

/**
 * The launcher's palette entry, for the empty canvas's strip to repeat while a
 * plugin's surface stands in for the launcher, so the region still offers a
 * way to start something.
 *
 * Icon-only: at 32px the label is the widest thing in the strip and it says
 * nothing the icon and its tooltip do not.
 */
export function SurfacePaletteAction() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Search agents &amp; panels…"
            onClick={() => {
              void actionService.dispatch("panel.palette", undefined, { source: "user" });
            }}
          >
            <Search aria-hidden="true" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Search agents &amp; panels…</TooltipContent>
    </Tooltip>
  );
}
