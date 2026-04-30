import { memo } from "react";
import { Button } from "@/components/ui/button";
import { PanelRightOpen, PanelRightClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { usePortalStore } from "@/store";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors relative";

export const ToolbarPortalButton = memo(function ToolbarPortalButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const portalOpen = usePortalStore((state) => state.isOpen);
  const togglePortal = usePortalStore((state) => state.toggle);
  const portalShortcut = useKeybindingDisplay("panel.togglePortal");
  const portalHintHover = useShortcutHintHover("panel.togglePortal");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...portalHintHover}
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
          <ShortcutRevealChip actionId="panel.togglePortal" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {createTooltipWithShortcut(
          portalOpen ? "Close Context Portal" : "Open Context Portal",
          portalShortcut
        )}
      </TooltipContent>
    </Tooltip>
  );
});
