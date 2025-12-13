import { useRef, useCallback, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedControlTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps {
  tabs: SegmentedControlTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function SegmentedControl({
  tabs,
  activeTab,
  onTabChange,
  className,
  ariaLabel = "Tab navigation",
}: SegmentedControlProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTab = useCallback(
    (index: number) => {
      const clampedIndex = Math.max(0, Math.min(index, tabs.length - 1));
      tabRefs.current[clampedIndex]?.focus();
    },
    [tabs.length]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      let handled = true;
      let newIndex = currentIndex;

      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          newIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
          break;
        case "ArrowRight":
        case "ArrowDown":
          newIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
          break;
        case "Home":
          newIndex = 0;
          break;
        case "End":
          newIndex = tabs.length - 1;
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        onTabChange(tabs[newIndex].id);
        focusTab(newIndex);
      }
    },
    [focusTab, tabs, onTabChange]
  );

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className={cn("pb-6", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex p-1 bg-black/20 rounded-[var(--radius-lg)] w-full"
      >
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-[var(--radius-md)] transition-all duration-200 ease-out",
                isActive
                  ? "bg-canopy-accent/10 text-canopy-accent"
                  : "text-canopy-text/60 hover:text-canopy-text hover:bg-white/5"
              )}
            >
              {tab.icon && (
                <span className={cn("opacity-70", isActive && "opacity-100")}>{tab.icon}</span>
              )}
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
