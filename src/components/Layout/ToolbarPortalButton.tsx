import { Button } from "@/components/ui/button";
import { MessageSquareMore } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { usePortalStore } from "@/store";

const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

export function ToolbarPortalButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const portalOpen = usePortalStore((state) => state.isOpen);
  const togglePortal = usePortalStore((state) => state.toggle);
  const portalShortcut = useEffectiveCombo("panel.togglePortal");
  const portalAriaShortcut = useAriaKeyshortcuts("panel.togglePortal");
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
          // A toggle keeps one name; aria-pressed announces the state and only
          // the tooltip reads differently.
          aria-label="Web chat"
          aria-pressed={portalOpen}
          aria-keyshortcuts={portalAriaShortcut}
        >
          <MessageSquareMore aria-hidden="true" />
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
}
