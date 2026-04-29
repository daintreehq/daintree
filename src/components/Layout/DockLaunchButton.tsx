import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DockLaunchMenuItems,
  type DockLaunchAgent,
  type DockLaunchMenuComponents,
} from "./DockLaunchMenuItems";
import type { RecipeContext } from "@/utils/recipeVariables";

const DROPDOWN_COMPONENTS: DockLaunchMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
};

interface DockLaunchButtonProps {
  agents: ReadonlyArray<DockLaunchAgent>;
  hasDevPreview: boolean;
  onLaunchAgent: (agentId: string) => void;
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
}

export function DockLaunchButton({
  agents,
  hasDevPreview,
  onLaunchAgent,
  activeWorktreeId,
  cwd,
  recipeContext,
}: DockLaunchButtonProps) {
  // Mirror AgentButton.tsx's tooltip-suppression pattern: when the dropdown
  // closes, Radix restores focus to the trigger and the tooltip would re-fire
  // on top of newly-launched panels. Hold suppression open until the next
  // genuine pointer hover (cleared via onPointerEnter).
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Lets us
  // preventDefault() the focus restoration only for pointer dismissals so the
  // launch pill doesn't keep its accent focus-visible ring; keyboard close
  // (Escape/Enter) still gets default focus return for WAI-ARIA.
  const wasPointerCloseRef = useRef(false);

  const handleTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setTooltipOpen(false);
      }}
    >
      <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="pill"
              size="sm"
              className="px-2"
              aria-label="Launch panel"
              onPointerEnter={() => {
                isRestoringFocusRef.current = false;
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Launch panel</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="min-w-[14rem]"
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
          if (wasPointerCloseRef.current) {
            e.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        <DockLaunchMenuItems
          components={DROPDOWN_COMPONENTS}
          agents={agents}
          hasDevPreview={hasDevPreview}
          activeWorktreeId={activeWorktreeId}
          cwd={cwd}
          recipeContext={recipeContext}
          onLaunchAgent={onLaunchAgent}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
