import { X } from "lucide-react";
import { SpinnerCircle, HollowCircle, InteractingCircle } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";

/**
 * Per-lane state marker (#12108).
 *
 * Same triad and tokens as the header's indicator — only working, directing
 * and waiting earn a marker; idle and exited stay quiet. This is the whole
 * reason the strip carries state at all: the header can only speak for the
 * lane on screen, so a background session that has gone to `waiting` is
 * otherwise invisible until the user happens to switch to it.
 */
function TabStateIndicator({ agentState }: { agentState: AgentState | null | undefined }) {
  if (agentState === "working") {
    return (
      <SpinnerCircle
        className="w-3 h-3 shrink-0 text-state-working animate-spin-slow motion-reduce:animate-none"
        aria-label="working"
      />
    );
  }
  if (agentState === "directing") {
    return (
      <InteractingCircle className="w-3 h-3 shrink-0 text-category-blue" aria-label="directing" />
    );
  }
  if (agentState === "waiting") {
    return <HollowCircle className="w-3 h-3 shrink-0 text-state-waiting" aria-label="waiting" />;
  }
  return null;
}

export interface HelpSessionTab {
  slot: number;
  label: string;
  agentState: AgentState | null | undefined;
}

interface HelpSessionTabsProps {
  tabs: HelpSessionTab[];
  activeSlot: number;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
}

/**
 * The parallel-session strip.
 *
 * Rendered only when a project has more than one assistant lane open, so a
 * single-session panel looks exactly as it did before lanes existed — the
 * common case pays nothing for the capability.
 *
 * No accent anywhere: the strip sits inside the assistant focus region, whose
 * one load-bearing accent is already spent on the focus ring. The active tab
 * is distinguished by surface and text hierarchy instead.
 */
export function HelpSessionTabs({ tabs, activeSlot, onSelect, onClose }: HelpSessionTabsProps) {
  if (tabs.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Assistant sessions"
      className="flex items-stretch gap-1 px-2 py-1 border-b border-border-default shrink-0 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const isActive = tab.slot === activeSlot;
        return (
          <div
            key={tab.slot}
            className={cn(
              "group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-[var(--radius-sm)] shrink-0",
              "transition-colors duration-150 ease-out",
              isActive ? "bg-overlay-subtle" : "hover:bg-tint/8"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tab.slot)}
              className={cn(
                "flex items-center gap-1.5 min-w-0 text-xs transition-colors duration-150 ease-out",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                isActive ? "text-text-primary font-medium" : "text-text-secondary"
              )}
            >
              <TabStateIndicator agentState={tab.agentState} />
              <span className="truncate max-w-[10rem]">{tab.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.slot)}
              // Always in the DOM so the control is reachable by keyboard and
              // by assistive tech; only its paint is hover/focus-gated, which
              // keeps the strip quiet without hiding the affordance.
              className={cn(
                "p-0.5 rounded-[var(--radius-sm)] shrink-0 text-text-secondary",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                "hover:text-text-primary hover:bg-tint/8 transition-[opacity,color,background-color] duration-150 ease-out",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              )}
              aria-label={`Close ${tab.label}`}
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
