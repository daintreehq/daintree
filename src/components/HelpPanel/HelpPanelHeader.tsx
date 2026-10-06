import { useState } from "react";
import { ChevronRight, CircleHelp, CircleStop, Ellipsis, History, RotateCw } from "lucide-react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SurfaceHeader, SURFACE_HEADER_FOCUS_LIFT_CLASS } from "@/components/ui/SurfaceHeader";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import type { AgentState } from "@/types";

/** The panel-chrome action button: `icon-xs` (24px target) with a 14px glyph. */
const HEADER_ACTION_CLASS = "[&_svg]:size-3.5";

/** What the active lane's state is called when it is spoken rather than drawn. */
const SPOKEN_STATE: Partial<Record<NonNullable<AgentState>, string>> = {
  working: "Assistant is working",
  directing: "Assistant is directing",
  waiting: "Assistant is waiting",
};

/**
 * The active lane's state, announced but not drawn.
 *
 * The header used to draw the same 14px marker the session strip draws, for the same
 * lane, one row apart — so a working session put two identical spinners on screen and
 * left the user to work out whether the panel or the conversation was busy. The strip
 * is now always present and its marker is per-lane, which is strictly more information
 * in a more specific place, so the visible duplicate is gone.
 *
 * What does not survive that deletion on its own is the announcement. A marker in the
 * strip reaches assistive tech through `aria-describedby`, which is read when a tab
 * takes focus and not when the state CHANGES — whereas the mark this replaces was a
 * `role="status"` live region that spoke on every transition. Keeping one here, with
 * no visual presence, preserves that for the lane on screen.
 */
function AssistantStateAnnouncer({ agentState }: { agentState: AgentState | null | undefined }) {
  const spoken = agentState ? SPOKEN_STATE[agentState] : undefined;
  return (
    <span
      data-testid="assistant-header-state-announcer"
      data-agent-state={agentState ?? undefined}
      role="status"
      className="sr-only"
    >
      {spoken ?? ""}
    </span>
  );
}

interface HelpPanelHeaderProps {
  /** The state of the lane on screen. Announced only — the strip draws it. */
  agentState: AgentState | null | undefined;
  canRestartConversation: boolean;
  canEndSession: boolean;
  onRestartConversation: () => void;
  onEndSession: () => void;
  onResumePastSession: () => void;
  onOpenDocs: () => void;
  onClose: () => void;
  isFocused?: boolean;
}

export function HelpPanelHeader({
  agentState,
  canRestartConversation,
  canEndSession,
  onRestartConversation,
  onEndSession,
  onResumePastSession,
  onOpenDocs,
  onClose,
  isFocused = false,
}: HelpPanelHeaderProps) {
  // The panel closes on Escape through the escape stack, which the global
  // keybinding layer pops at window capture — before Radix's menu sees the key.
  // An open overflow menu registers above the panel so Escape closes the menu
  // first, not the whole assistant.
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  useEscapeStack(isMenuOpen, () => setIsMenuOpen(false));
  return (
    <SurfaceHeader
      density="compact"
      className={cn(
        "gap-1 transition-colors",
        // The same lift a focused grid pane's title bar takes, so the assistant
        // and the pane beside it read as one family when either has the
        // keyboard. The divider steps up to `--border-overlay` to match the
        // `.terminal-selected` header rule in index.css — through the
        // `border-overlay` class, because the frame's `.border-divider` is a
        // custom rule that outranks an arbitrary `border-b-[…]` colour. Scoped to the header
        // (not the aside) so the launching skeleton, the empty state and any
        // no-terminal content stay on `bg-surface-canvas`. Neutral lift, no
        // accent, per the single-anchor-per-region rule.
        isFocused && [SURFACE_HEADER_FOCUS_LIFT_CLASS, "border-overlay"]
      )}
    >
      <div className="flex items-center min-w-0 flex-1">
        <DaintreeIcon className="w-4 h-4 text-text-secondary shrink-0" />
        <span className="ml-1.5 text-xs font-medium text-text-secondary truncate">
          Daintree Assistant
        </span>
        <AssistantStateAnnouncer agentState={agentState} />
      </div>
      {/* The header carries panel-level actions only. Anything scoped to ONE
          conversation belongs to the strip, which is where the sessions are.

          The `+` that used to sit here is gone. It restarted the current
          conversation, while the strip a row below grew a control that opened
          another session — two plus-shaped affordances a few pixels apart doing
          different things, and only the destructive one was visible. Restarting
          is now a named overflow item, and the strip owns the only `+`. */}
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={HEADER_ACTION_CLASS}
                aria-label="More actions"
                aria-haspopup="menu"
                data-testid="assistant-header-more"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          {/* Named for what it does to the conversation, not for what it does to
              the session. "Start new session" read as "give me another session",
              which is the strip's `+` — and this is the one that throws the
              current conversation away. Opening a parallel session is NOT
              mirrored here: the strip's `+` is its single home. */}
          {canRestartConversation && (
            <>
              <DropdownMenuItem destructive onSelect={onRestartConversation}>
                <RotateCw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Restart conversation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={onResumePastSession}>
            <History className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Resume a past session…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenDocs}>
            <CircleHelp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Open docs
          </DropdownMenuItem>
          {canEndSession && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onEndSession}>
                <CircleStop className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Stop assistant
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className={HEADER_ACTION_CLASS}
            aria-label="Hide Daintree Assistant"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Hide Daintree Assistant</TooltipContent>
      </Tooltip>
    </SurfaceHeader>
  );
}
