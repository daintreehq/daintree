import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import type { HelpSessionPhase } from "@/controllers/HelpSessionController";

interface HelpLaunchingStateProps {
  /** Current launch FSM phase. The parent only mounts this for non-idle/non-live phases. */
  phase: HelpSessionPhase;
  /** Drives the 400ms Doherty gate — keep true while the launch is in flight. */
  isLoading: boolean;
  /** Aborts the in-flight launch. Surfaced as a Cancel button by `SkeletonHint` with the first hint. */
  onCancel: () => void;
}

// "Still working…" at 5s, per the loading-indicator ladder. SkeletonHint's own 8s
// default is tuned for skeletons that at least promise a shape; a spinner promises
// nothing, so the reassurance (and Cancel with it) should come sooner.
const STILL_WORKING_AFTER_MS = 5_000;

// Exhaustive over HelpSessionPhase so adding a phase without a label fails to
// compile. idle/live never reach the rendered state (the parent gates them
// out), so they map to an empty label.
function phaseLabel(phase: HelpSessionPhase): string {
  switch (phase) {
    case "version-checking":
      return "Checking version…";
    case "provisioning":
      return "Preparing session…";
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
 * Phase-labelled progress for the assistant launch sequence (6–45s), and for the
 * save on hibernate. A spinner rather than a skeleton: what lands here is a
 * terminal, which has no shape a placeholder could honestly predict — the same
 * call `TerminalStartupPlaceholder` makes for an agent pane starting up.
 *
 * Gated behind the 400ms Doherty threshold to avoid flicker on fast launches.
 * The hint sits in a reserved slot directly under the phase, so neither its
 * arrival nor its escalation moves the spinner.
 */
export function HelpLaunchingState({ phase, isLoading, onCancel }: HelpLaunchingStateProps) {
  const show = useDohertyGate(isLoading);
  const label = show ? phaseLabel(phase) : "";

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
      {/* The phase's one announcer. Mounted empty before the gate and kept outside
          any aria-busy subtree, so each phase is spoken exactly once — the visible
          label below is hidden from AT rather than announced a second time. */}
      <span className="sr-only" role="status" aria-atomic="true">
        {label}
      </span>
      {show && (
        <div aria-hidden="true" className="flex flex-col items-center gap-3 text-center">
          <Spinner size="xl" className="text-text-secondary" />
          <p className="text-sm text-text-secondary">{label}</p>
        </div>
      )}
      {/* Mounted from the start so its thresholds count from the launch, not from
          the gate. `min-h-7` reserves the row's height (the size="sm" Cancel). */}
      <SkeletonHint
        className="mt-4 min-h-7 flex items-center justify-center"
        firstThreshold={STILL_WORKING_AFTER_MS}
        onCancel={onCancel}
      />
    </div>
  );
}
