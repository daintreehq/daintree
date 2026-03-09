import { useEffect, useRef } from "react";
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activePillRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activePillRef.current && scrollContainerRef.current) {
      activePillRef.current.scrollIntoView?.({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeId]);

  if (subtabs.length === 0) return null;

  return (
    <nav
      ref={scrollContainerRef}
      aria-label="Subtab navigation"
      className="flex gap-1.5 p-1.5 bg-canopy-bg rounded-[var(--radius-lg)] border border-canopy-border overflow-x-auto scrollbar-thin mb-6"
    >
      {subtabs.map((subtab) => {
        const isActive = subtab.id === activeId;
        return (
          <button
            key={subtab.id}
            ref={isActive ? activePillRef : null}
            aria-current={isActive ? "true" : undefined}
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
    </nav>
  );
}
