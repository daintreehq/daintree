import type { PowerPolicyLevel } from "../../../shared/types/powerPolicy.js";

// Per-isolate mirror of main's power policy. The pty-host main thread and every
// analysis worker each hold their own copy (module state is isolate-scoped),
// set by `set-power-policy` on the host and the `power-policy` worker message
// respectively. ActivityMonitor reads it in either execution mode, so no
// per-terminal plumbing is needed.

let level: PowerPolicyLevel = "active";
// How hard to pace agent-state observation specifically. Derived in main by
// `deriveAgentObservationLevel`, not here: the inputs that separate it from
// `level` (which window is on screen, and the power source) do not exist in
// this isolate. Defaults to `active` for the same reason `level` does — an
// isolate that has not heard from main must not assume nobody is looking.
let observationLevel: PowerPolicyLevel = "active";
const listeners = new Set<(level: PowerPolicyLevel) => void>();

export function getPtyPowerLevel(): PowerPolicyLevel {
  return level;
}

/**
 * The level to pace agent observation by, which is not the same question as how
 * hard the machine should work generally: a blurred but visible window is still
 * being glanced at. Deliberately separate from {@link getPtyPowerLevel}, which
 * still paces work whose cost has nothing to do with whether anyone is watching
 * a sidebar (the governor's FD sweeps, analysis-worker memory sampling).
 */
export function getAgentObservationLevel(): PowerPolicyLevel {
  return observationLevel;
}

/**
 * `nextObservationLevel` is optional so an isolate that has not been taught to
 * send it still behaves as it did before: the raw level was what paced
 * observation.
 */
export function setPtyPowerLevel(
  next: PowerPolicyLevel,
  nextObservationLevel?: PowerPolicyLevel
): void {
  const resolvedObservation = nextObservationLevel ?? next;
  const changed = next !== level || resolvedObservation !== observationLevel;
  level = next;
  observationLevel = resolvedObservation;
  // An observation change with the raw level unchanged still has to notify, or
  // consumers pacing on it never re-time.
  if (!changed) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch (error) {
      console.error("[PtyPowerPolicy] listener threw:", error);
    }
  }
}

export function subscribePtyPowerLevel(listener: (level: PowerPolicyLevel) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPtyPowerLevelForTesting(): void {
  level = "active";
  observationLevel = "active";
  listeners.clear();
}
