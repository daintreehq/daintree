import type {
  DevPreviewToolButtonProps,
  DevPreviewToolContext,
} from "@/registry/devPreviewToolRegistry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SquareDashedMousePointer } from "lucide-react";
import { cn } from "@/lib/utils";

// A literal, not `shared/protocol.ts`: this button is in the eager bundle and
// the protocol module pulls in zod. `__tests__/entryIds.test.ts` checks it.
export const BUTTON_PLUGIN_ID = "daintree.sveltekit-builder";

/**
 * Whether this preview can be picked from: the tool's one availability
 * answer, which the host uses for both the toolbar toggle and any command
 * aimed at it. Any framework's page can be, so nothing here asks what the
 * worktree holds — a SvelteKit app only adds source tracing on top. A request
 * goes to an agent in a worktree, so a preview without one has nowhere to send.
 */
export function siteBuilderApplies(context: DevPreviewToolContext): Promise<boolean> {
  return Promise.resolve(Boolean(context.projectId && context.worktreeId && context.worktreePath));
}

/** Why a command is refused where the picker does not apply. */
export const SITE_BUILDER_UNAVAILABLE_REASON =
  "The Element Picker needs a dev preview that belongs to a worktree";

/**
 * The dev preview toolbar toggle. Where it is shown is the host's call — it
 * asks `siteBuilderApplies` for this preview.
 */
export function SiteBuilderButton({ active, onToggle }: DevPreviewToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Element Picker"
          aria-pressed={active}
          className={cn(
            "toolbar-icon-button rounded-[var(--radius-md)] p-1.5",
            active && "bg-overlay-soft text-text-primary"
          )}
        >
          <SquareDashedMousePointer className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {active ? "Close Element Picker" : "Pick an element and ask an agent to change it"}
      </TooltipContent>
    </Tooltip>
  );
}
