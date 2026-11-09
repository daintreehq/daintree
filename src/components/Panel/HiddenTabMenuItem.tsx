import { usePanelStore } from "@/store";
import { withDisplayEmoji } from "@shared/utils/displayIdentity";
import { cn } from "@/lib/utils";
import { DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
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
  // As the tab itself shows it: the emoji is what tells two same-named tabs apart.
  const displayEmoji = usePanelStore((s) => s.panelsById[tab.id]?.displayEmoji);

  return (
    // A radio row of the menu's group: the current tab wears the leading-gutter
    // check, and selecting any row (the current one included) activates it.
    <DropdownMenuRadioItem value={tab.id} onSelect={onSelect}>
      <span className="shrink-0 mr-2 inline-flex items-center justify-center w-3.5 h-3.5">
        <TerminalIcon
          kind={tab.kind}
          chrome={tab.chrome}
          className="w-3.5 h-3.5"
          brandColor={tab.presetColor ?? tab.chrome.color}
        />
      </span>
      <span className="mr-3 truncate">{withDisplayEmoji(tab.title, displayEmoji)}</span>
      {state && <span className="sr-only">, {SESSION_LABELS[state]}</span>}
      {StateIcon && state && (
        <StateIcon
          className={cn(
            "ml-auto h-3 w-3 shrink-0",
            SESSION_COLORS[state],
            state === "working" && "animate-spin-slow motion-reduce:animate-none"
          )}
          aria-hidden="true"
        />
      )}
    </DropdownMenuRadioItem>
  );
}
