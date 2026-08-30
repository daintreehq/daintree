import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import type { HelpSessionPhase } from "@/controllers/HelpSessionController";

interface HelpLaunchingStateProps {
  /** Current launch FSM phase. The parent only mounts this for non-idle/non-live phases. */
  phase: HelpSessionPhase;
  /** Drives the 400ms Doherty gate — keep true while the launch is in flight. */
  isLoading: boolean;
  /** Aborts the in-flight launch. Surfaced as a Cancel button by `SkeletonHint` with the first hint. */
  onCancel: () => void;
}

// Exhaustive over HelpSessionPhase so adding a phase without a label fails to
// compile. idle/live never reach the rendered skeleton (the parent gates them
// out), so they map to an empty label.
function phaseLabel(phase: HelpSessionPhase): string {
  switch (phase) {
    case "version-checking":
      return "Checking version…";
    case "provisioning":
      return "Provisioning session…";
    case "launching":
      return "Starting assistant…";
    case "hibernating":
      return "Saving session…";
    case "idle":
    case "live":
      return "";
  }
}

/**
 * Phase-labeled loading skeleton for the assistant launch sequence. Replaces
 * the static empty state while auto-launch / select-agent runs (6–45s), so the
 * panel proves it's working instead of looking idle. Gated behind the 400ms
 * Doherty threshold to avoid flicker on fast launches; `SkeletonHint` surfaces
 * Cancel with the first hint (8s) and escalates copy for the long tail.
 */
export function HelpLaunchingState({ phase, isLoading, onCancel }: HelpLaunchingStateProps) {
  const show = useDohertyGate(isLoading);
  if (!show) return null;

  const label = phaseLabel(phase);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 relative">
      <Skeleton label={label} className="flex flex-col items-center gap-4 w-full max-w-[28ch]">
        <div className="w-full flex flex-col gap-2.5" aria-hidden="true">
          <SkeletonBone className="h-3 w-3/5" />
          <SkeletonBone className="h-2.5 w-full" />
          <SkeletonBone className="h-2.5 w-4/5" />
        </div>
        <p aria-hidden="true" className="text-xs text-text-secondary">
          {label}
        </p>
      </Skeleton>

      <SkeletonHint
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
        message={label}
        onCancel={onCancel}
      />
    </div>
  );
}
