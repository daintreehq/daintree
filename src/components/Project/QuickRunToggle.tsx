import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { QUICK_RUN_EXPANDED_KEY_PREFIX } from "./quickRunStorageKeys";

export const QUICK_RUN_PANEL_ID = "quick-run-panel";

/**
 * Whether QuickRun's panel is open, remembered per project. Collapsed by default.
 *
 * This is a launcher for something most sessions never run, and it used to open
 * expanded every time and forget being closed, so it permanently spent roughly
 * 88px of a 320px column on the third-priority question the footer answers.
 *
 * Lives in a hook rather than inside `QuickRun` because the toggle no longer
 * sits on the panel: it rides the footer's status row, and the panel mounts
 * only while open.
 */
export function useQuickRunExpanded(projectId: string | null): [boolean, () => void] {
  const read = (id: string | null) => {
    if (id == null) return false;
    try {
      return (
        localStorage.getItem(`${QUICK_RUN_EXPANDED_KEY_PREFIX}${hostScopedKey(id)}`) === "true"
      );
    } catch {
      return false;
    }
  };
  const [state, setState] = useState(() => ({ projectId, expanded: read(projectId) }));
  // Re-read on a project switch during render rather than in an effect, so the
  // first frame of the new project never shows the old one's panel.
  const current = state.projectId === projectId ? state : { projectId, expanded: read(projectId) };
  if (current !== state) setState(current);

  const toggle = () => {
    const next = !current.expanded;
    setState({ projectId, expanded: next });
    if (projectId == null) return;
    try {
      localStorage.setItem(
        `${QUICK_RUN_EXPANDED_KEY_PREFIX}${hostScopedKey(projectId)}`,
        String(next)
      );
    } catch {
      // a session that cannot persist still gets the toggle
    }
  };

  return [current.expanded, toggle];
}

interface QuickRunToggleProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The disclosure for QuickRun's panel, pinned to the right of the footer's
 * status row so the footer is one row rather than two stacked strips that each
 * led with a glyph and a label. Ambient state on the left, the contextual
 * control on the right: the status-bar polarity VS Code and macOS both use.
 *
 * The label stays "Run command" whether open or closed — toggle labels never
 * change with state; the chevron and `aria-expanded` carry that. Below 280px it
 * shortens to "Run" so the status on the left keeps its words.
 */
export function QuickRunToggle({ expanded, onToggle }: QuickRunToggleProps) {
  return (
    <button
      type="button"
      data-quick-run-toggle=""
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={QUICK_RUN_PANEL_ID}
      aria-label="Run command"
      className={cn(
        "flex shrink-0 items-center gap-1 self-stretch px-3 text-2xs font-medium transition-colors",
        expanded
          ? "bg-overlay-soft text-text-primary"
          : "text-text-secondary hover:bg-overlay-soft hover:text-text-primary",
        "focus-visible:bg-overlay-medium focus-visible:text-text-primary",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
      )}
    >
      <span>
        Run<span className="@max-[280px]/footer:hidden"> command</span>
      </span>
      <ChevronDown
        data-animated-chevron
        className={cn(
          "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
          !expanded && "rotate-180"
        )}
        aria-hidden="true"
      />
    </button>
  );
}
