import type { PowerPolicyLevel } from "../../../shared/types/powerPolicy.js";

// Per-isolate mirror of main's power-policy level. The pty-host main thread
// and every analysis worker each hold their own copy (module state is
// isolate-scoped), set by `set-power-policy` on the host and the
// `power-policy` worker message respectively. ActivityMonitor reads it in
// either execution mode, so no per-terminal plumbing is needed.

let level: PowerPolicyLevel = "active";
const listeners = new Set<(level: PowerPolicyLevel) => void>();

export function getPtyPowerLevel(): PowerPolicyLevel {
  return level;
}

export function setPtyPowerLevel(next: PowerPolicyLevel): void {
  if (next === level) return;
  level = next;
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
  listeners.clear();
}
