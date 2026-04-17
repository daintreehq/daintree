import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEscapeStack } from "@/hooks";
import { useFleetArmingStore, type FleetArmStatePreset } from "@/store/fleetArmingStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

interface PresetOption {
  value: FleetArmStatePreset;
  label: string;
}

const PRESETS: PresetOption[] = [
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "finished", label: "Finished" },
];

export function FleetArmingRibbon(): ReactElement | null {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const clear = useFleetArmingStore((s) => s.clear);
  const armByState = useFleetArmingStore((s) => s.armByState);

  useEscapeStack(armedCount > 0, clear);

  const lastAnnouncedCount = useRef<number>(0);
  useEffect(() => {
    if (armedCount === lastAnnouncedCount.current) return;
    const announce = useAnnouncerStore.getState().announce;
    if (armedCount === 0 && lastAnnouncedCount.current > 0) {
      announce("Fleet disarmed");
    } else if (armedCount > 0) {
      announce(`${armedCount} ${armedCount === 1 ? "agent" : "agents"} armed`);
    }
    lastAnnouncedCount.current = armedCount;
  }, [armedCount]);

  const hint = useMemo(() => {
    return "Esc to disarm · Shift-click to extend · Cmd-click to toggle";
  }, []);

  if (armedCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="off"
      className="flex items-center gap-3 border-b border-daintree-accent/40 bg-daintree-accent/10 px-3 py-1.5 text-[12px] text-daintree-text"
      data-testid="fleet-arming-ribbon"
    >
      <span className="font-medium text-daintree-accent">
        {armedCount} {armedCount === 1 ? "agent" : "agents"} armed
      </span>
      <div className="flex items-center gap-1" role="toolbar" aria-label="Arm by state">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={(e) => {
              armByState(preset.value, "current", e.shiftKey);
            }}
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] transition-colors",
              "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.14] hover:text-daintree-text"
            )}
            aria-label={`Arm ${preset.label.toLowerCase()} agents (shift to extend)`}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <span className="ml-auto text-[11px] text-daintree-text/50">{hint}</span>
      <button
        type="button"
        onClick={clear}
        aria-label="Disarm all"
        className="rounded p-1 text-daintree-text/60 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
