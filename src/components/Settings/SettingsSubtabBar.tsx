import { useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHorizontalScrollControls } from "@/hooks/useHorizontalScrollControls";

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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activePillRef = useRef<HTMLButtonElement>(null);

  const { canScrollLeft, canScrollRight } = useHorizontalScrollControls(scrollContainerRef);

  useEffect(() => {
    if (activePillRef.current && scrollContainerRef.current) {
      activePillRef.current.scrollIntoView?.({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeId]);

  const handleScrollLeft = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerLeft = container.getBoundingClientRect().left;
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const target = [...tabs]
      .reverse()
      .find((tab) => tab.getBoundingClientRect().left < containerLeft - 1);
    target?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  }, []);

  const handleScrollRight = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerRight = container.getBoundingClientRect().right;
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const target = tabs.find((tab) => tab.getBoundingClientRect().right > containerRight + 1);
    target?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
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
    <div className="relative mb-6">
      {canScrollLeft && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-r from-canopy-bg via-canopy-bg/90 to-transparent pr-4 rounded-l-[var(--radius-lg)]">
          <button
            type="button"
            onClick={handleScrollLeft}
            className={cn(
              "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
              "rounded-[var(--radius-md)] transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            )}
            aria-label="Scroll tabs left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        role="tablist"
        aria-label="Subtab navigation"
        onKeyDown={handleKeyDown}
        className="flex gap-1.5 p-1.5 bg-canopy-bg rounded-[var(--radius-lg)] border border-canopy-border overflow-x-auto no-scrollbar scroll-smooth"
      >
        {subtabs.map((subtab) => {
          const isActive = subtab.id === activeId;
          return (
            <button
              key={subtab.id}
              ref={isActive ? activePillRef : null}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-tab={subtab.id}
              onClick={() => onChange(subtab.id)}
              className={cn(
                "flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium transition-all flex-shrink-0",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                isActive
                  ? "bg-canopy-sidebar text-canopy-text shadow-sm"
                  : "text-canopy-text/60 hover:text-canopy-text hover:bg-white/5"
              )}
            >
              {subtab.renderIcon?.(isActive)}
              <span className="truncate">{subtab.label}</span>
              {subtab.trailing && (
                <span className="flex items-center gap-1 shrink-0">{subtab.trailing}</span>
              )}
            </button>
          );
        })}
      </div>

      {canScrollRight && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-l from-canopy-bg via-canopy-bg/90 to-transparent pl-4 rounded-r-[var(--radius-lg)]">
          <button
            type="button"
            onClick={handleScrollRight}
            className={cn(
              "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
              "rounded-[var(--radius-md)] transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            )}
            aria-label="Scroll tabs right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
