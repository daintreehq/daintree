import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSubtabItem {
  id: string;
  label: string;
  renderIcon?: (isActive: boolean) => ReactNode;
  trailing?: ReactNode;
}

interface SettingsSubtabBarProps {
  subtabs: SettingsSubtabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /**
   * Distinguishes this bar's ids from every other subtab bar in the dialog, and keys
   * `subtabPanelProps` so a consumer can point its panel back at the right tab.
   */
  group: string;
  /**
   * The tablist's accessible name. Required because the settings dialog nests this bar
   * inside the sidebar's own tablist, and the WAI-ARIA Tabs pattern needs each of two
   * nested tablists to say which one it is — "Subtab navigation" on all five of them
   * told a screen-reader user nothing about which level they were driving.
   */
  ariaLabel: string;
}

const tabId = (group: string, id: string) => `settings-subtab-${group}-${id}`;
const panelId = (group: string, id: string) => `settings-subtabpanel-${group}-${id}`;

/**
 * Props for the element holding the active subtab's content. Spread onto a wrapper the
 * consumer renders, so the tab and its panel reference each other the way the sidebar
 * tablist and its panels already do.
 */
export function subtabPanelProps(group: string, activeId: string) {
  return {
    role: "tabpanel" as const,
    id: panelId(group, activeId),
    "aria-labelledby": tabId(group, activeId),
    tabIndex: -1,
  };
}

export function SettingsSubtabBar({
  subtabs,
  activeId,
  onChange,
  group,
  ariaLabel,
}: SettingsSubtabBarProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const focusedIndex = tabs.indexOf(document.activeElement as HTMLElement);
    if (focusedIndex === -1) return;

    let nextIndex: number | null = null;

    switch (e.key) {
      case "ArrowRight":
        nextIndex = (focusedIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (focusedIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    tabs[nextIndex]!.focus();
    const nextTabId = tabs[nextIndex]!.dataset.tab;
    if (nextTabId) onChange(nextTabId);
  };

  if (subtabs.length === 0) return null;

  return (
    <div className="border-b border-border-default mb-6">
      <div
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className="flex gap-x-1 -mb-px"
      >
        {subtabs.map((subtab) => {
          const isActive = subtab.id === activeId;
          return (
            <button
              key={subtab.id}
              role="tab"
              id={tabId(group, subtab.id)}
              aria-selected={isActive}
              aria-controls={panelId(group, subtab.id)}
              tabIndex={isActive ? 0 : -1}
              data-tab={subtab.id}
              onClick={() => onChange(subtab.id)}
              className={cn(
                "inline-flex items-center gap-2 px-3 pb-2.5 pt-0.5 text-sm font-medium",
                "transition-[color] duration-150 flex-shrink-0",
                // -outline-offset keeps the ring inside the button's own box. With a
                // positive offset the top edge was clipped by the scrollport whenever the
                // bar sat against the dialog header, leaving an open-topped "U".
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2 focus-visible:rounded-[var(--radius-sm)]",
                isActive
                  ? "border-b-2 border-accent-primary text-text-primary"
                  : "border-b-2 border-transparent text-text-secondary hover:border-border-default hover:text-text-primary"
              )}
            >
              {subtab.renderIcon?.(isActive)}
              <span>{subtab.label}</span>
              {subtab.trailing && (
                <span className="flex items-center gap-1 shrink-0">{subtab.trailing}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
