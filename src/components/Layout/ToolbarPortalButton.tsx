import { memo } from "react";
import { Button } from "@/components/ui/button";
import { BotMessageSquare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
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
          aria-label={portalOpen ? "Close web chat" : "Open web chat"}
          aria-pressed={portalOpen}
        >
          <BotMessageSquare aria-hidden="true" />
          <ShortcutRevealChip actionId="panel.togglePortal" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {createTooltipContent(
          portalOpen ? "Close web chat" : "Web chat: Claude, ChatGPT, Gemini",
          portalShortcut
        )}
      </TooltipContent>
    </Tooltip>
  );
});
