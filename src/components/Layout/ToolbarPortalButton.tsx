import { memo } from "react";
import { Button } from "@/components/ui/button";
import { PanelRightOpen, PanelRightClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay } from "@/hooks";
import { usePortalStore } from "@/store";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";

export const ToolbarPortalButton = memo(function ToolbarPortalButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const portalOpen = usePortalStore((state) => state.isOpen);
  const togglePortal = usePortalStore((state) => state.toggle);
  const portalShortcut = useKeybindingDisplay("panel.togglePortal");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-toolbar-item={dataToolbarItem}
            onClick={togglePortal}
            className={toolbarIconButtonClass}
            aria-label={portalOpen ? "Close context portal" : "Open context portal"}
            aria-pressed={portalOpen}
          >
            {portalOpen ? (
              <PanelRightClose aria-hidden="true" />
            ) : (
              <PanelRightOpen aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {createTooltipWithShortcut(
            portalOpen ? "Close Context Portal" : "Open Context Portal",
            portalShortcut
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
