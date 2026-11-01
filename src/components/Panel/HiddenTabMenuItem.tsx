import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import {
  SESSION_COLORS,
  SESSION_ICONS,
  SESSION_LABELS,
} from "@/components/Worktree/terminalStateConfig";
import { useRunSessionPresentation } from "@/hooks/useRunSessionPresentation";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import type { TabInfo } from "./TabButton";

/**
 * One row of a tab strip's overflow menu. A tab that has scrolled out of the
 * strip is still the same tab, so its row resolves the session the way the
 * tab itself does (`TabButton`): from the run's fleet band, never as the amber
 * waiting ring a prompt would show from the raw agent state.
 */
export function HiddenTabMenuItem({ tab, onSelect }: { tab: TabInfo; onSelect: () => void }) {
  const state = useRunSessionPresentation(
    tab.id,
    getTerminalAgentDisplayState(tab.chrome, tab.agentState)
  );
  const StateIcon = state ? SESSION_ICONS[state] : null;

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      aria-current={tab.isActive ? "true" : undefined}
      // The tab on screen takes the committed-value check, as in the
      // docked tab-group menu, not weight alone.
      className={cn(tab.isActive && "font-medium")}
    >
      <span className="shrink-0 mr-2 inline-flex items-center justify-center w-3.5 h-3.5">
        <TerminalIcon
          kind={tab.kind}
          chrome={tab.chrome}
          className="w-3.5 h-3.5"
          brandColor={tab.presetColor ?? tab.chrome.color}
        />
      </span>
      <span className="mr-3 truncate">{tab.title}</span>
      {state && <span className="sr-only">, {SESSION_LABELS[state]}</span>}
      {tab.isActive && (
        <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      {StateIcon && state && (
        <StateIcon
          className={cn(
            tab.isActive ? "ml-1.5" : "ml-auto",
            "h-3 w-3 shrink-0",
            SESSION_COLORS[state],
            state === "working" && "animate-spin-slow motion-reduce:animate-none"
          )}
          aria-hidden="true"
        />
      )}
    </DropdownMenuItem>
  );
}
