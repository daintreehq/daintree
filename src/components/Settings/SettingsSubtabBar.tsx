import { useCallback } from "react";
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
}

export function SettingsSubtabBar({ subtabs, activeId, onChange }: SettingsSubtabBarProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      tabs[nextIndex].focus();
      const tabId = tabs[nextIndex].dataset.tab;
      if (tabId) onChange(tabId);
    },
    [onChange]
  );

  if (subtabs.length === 0) return null;

  return (
    <div className="border-b border-canopy-border mb-6">
      <div
        role="tablist"
        aria-label="Subtab navigation"
        onKeyDown={handleKeyDown}
        className="flex gap-x-1 -mb-px"
      >
        {subtabs.map((subtab) => {
          const isActive = subtab.id === activeId;
          return (
            <button
              key={subtab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-tab={subtab.id}
              onClick={() => onChange(subtab.id)}
              className={cn(
                "inline-flex items-center gap-2 px-3 pb-2.5 pt-0.5 text-sm font-medium",
                "transition-colors flex-shrink-0",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                isActive
                  ? "border-canopy-accent border-b-[var(--recipe-settings-subtab-active-border-width)] rounded-t-[var(--recipe-settings-subtab-active-radius)] text-canopy-text"
                  : "border-b-2 border-transparent text-text-secondary hover:text-canopy-text hover:border-[var(--recipe-settings-subtab-hover-border)] hover:bg-[var(--recipe-settings-subtab-hover-bg)] hover:rounded-t-[var(--recipe-settings-subtab-hover-radius)]"
              )}
              style={
                isActive ? { background: "var(--recipe-settings-subtab-active-bg)" } : undefined
              }
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
