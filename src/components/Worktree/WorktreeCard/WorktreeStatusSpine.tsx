import { cn } from "@/lib/utils";
import type { SpineState } from "./hooks/useWorktreeStatus";

export function WorktreeStatusSpine({ spineState }: { spineState: SpineState }) {
  return (
    <div
      className={cn(
        "absolute left-0 top-0 bottom-0 w-0.5 transition-all duration-300 rounded-r-sm",
        spineState === "error" && "bg-[var(--color-status-error)]",
        spineState === "dirty" &&
          "bg-[var(--color-status-warning)] shadow-[0_0_4px_rgba(251,191,36,0.2)]",
        spineState === "stale" && "bg-[var(--color-state-idle)]",
        spineState === "current" &&
          "bg-[var(--color-status-info)] shadow-[0_0_6px_rgba(56,189,248,0.25)]",
        spineState === "idle" && "bg-transparent"
      )}
      aria-hidden="true"
    />
  );
}
