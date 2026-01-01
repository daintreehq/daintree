import { ChevronUp, ChevronDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useDockStore } from "@/store";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";

export function DockHandleOverlay() {
  const { mode, toggleExpanded, setMode } = useDockStore(
    useShallow((state) => ({
      mode: state.mode,
      toggleExpanded: state.toggleExpanded,
      setMode: state.setMode,
    }))
  );

  const toggleShortcut = useKeybindingDisplay("panel.toggleDock");

  const isVisible = mode === "expanded" || mode === "slim";
  const Icon = isVisible ? ChevronDown : ChevronUp;

  const tooltipParts = [
    isVisible ? "Hide dock" : "Show dock",
    toggleShortcut && `(${toggleShortcut})`,
  ].filter(Boolean);
  const tooltip = tooltipParts.join(" ");

  const handleClick = () => {
    if (mode === "expanded" || mode === "slim") {
      setMode("hidden");
    } else {
      setMode("expanded");
    }
  };

  return (
    <div className={cn("absolute bottom-0 left-1/2 -translate-x-1/2 z-50", "pointer-events-none")}>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "pointer-events-auto",
          "flex items-center justify-center",
          "w-10 h-5 rounded-t-md",
          "bg-[var(--dock-bg)]/90 backdrop-blur-sm",
          "border border-b-0 border-[var(--dock-border)]",
          "text-canopy-text/40 hover:text-canopy-text/70",
          "transition-colors duration-150",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
        )}
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={isVisible}
      >
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
