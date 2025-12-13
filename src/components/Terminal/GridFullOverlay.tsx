import { Ban } from "lucide-react";

export interface GridFullOverlayProps {
  maxTerminals: number;
  show: boolean;
}

/**
 * Overlay displayed when attempting to drag a terminal to a full grid.
 * Uses pointer-events-none to allow drag operations underneath.
 */
export function GridFullOverlay({ maxTerminals, show }: GridFullOverlayProps) {
  if (!show) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
      <div className="flex flex-col items-center gap-3 text-center px-6 py-4 rounded-[var(--radius-xl)] bg-canopy-bg/90 border border-canopy-border/40 shadow-xl">
        <Ban className="h-8 w-8 text-amber-400" />
        <div>
          <p className="text-sm font-medium text-canopy-text">Grid is full</p>
          <p className="text-xs text-canopy-text/60 mt-1">
            Maximum {maxTerminals} terminals. Close one to add more.
          </p>
        </div>
      </div>
    </div>
  );
}
