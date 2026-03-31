import { cn } from "@/lib/utils";
import { usePreferencesStore, type DockDensity } from "@/store/preferencesStore";

const DOCK_DENSITY_OPTIONS: Array<{ id: DockDensity; label: string; description: string }> = [
  { id: "compact", label: "Compact", description: "Smaller items, tighter spacing" },
  { id: "normal", label: "Normal", description: "Default dock size" },
  { id: "comfortable", label: "Comfortable", description: "Larger items, more spacing" },
];

export function DockDensityPicker() {
  const dockDensity = usePreferencesStore((s) => s.dockDensity);
  const setDockDensity = usePreferencesStore((s) => s.setDockDensity);

  return (
    <div className="flex gap-2">
      {DOCK_DENSITY_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => setDockDensity(option.id)}
          className={cn(
            "flex-1 px-3 py-2 rounded-[var(--radius-md)] border text-sm transition-colors text-left",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            dockDensity === option.id
              ? "border-canopy-accent bg-canopy-accent/10 text-canopy-text"
              : "border-border-interactive bg-canopy-bg text-text-secondary hover:border-canopy-text/30 hover:text-canopy-text"
          )}
          aria-pressed={dockDensity === option.id}
        >
          <div className="font-medium">{option.label}</div>
          <div className="text-xs text-canopy-text/50 mt-0.5">{option.description}</div>
        </button>
      ))}
    </div>
  );
}
