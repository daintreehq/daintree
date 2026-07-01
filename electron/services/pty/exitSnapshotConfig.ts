/**
 * Pty-host-side gate for opt-in exit snapshots (#10850). The source of truth is
 * the main-process store (`terminalConfig.exitSnapshotEnabled`) plus each
 * project's `exitSnapshotExcluded` flag; main pushes both into the host via the
 * `set-exit-snapshot-enabled` / `set-exit-snapshot-excluded-projects` messages
 * (mirroring `set-session-persist-suppressed`). The host reads this module when
 * deciding whether to capture a tail at close, so all three close paths
 * (trash-expiry, kill, app-quit) share one decision.
 *
 * Default OFF — capture only happens after main explicitly enables it, which is
 * itself an opt-in setting off by default. Excluded-project state is a full-set
 * replacement (not deltas), matching how main recomputes it on every save.
 */
let exitSnapshotEnabled = false;
let excludedProjectIds = new Set<string>();

export function setExitSnapshotEnabled(enabled: boolean): void {
  exitSnapshotEnabled = enabled;
}

export function setExitSnapshotExcludedProjects(projectIds: string[]): void {
  excludedProjectIds = new Set(projectIds);
}

/**
 * True when an exit snapshot should be captured for a closing terminal:
 * it must be an agent terminal (has a launch hint), the global toggle must be
 * on, and its project must not be excluded. A null/absent project id is never
 * excluded (there is no per-project opt-out to honor).
 */
export function shouldCaptureExitSnapshot(input: {
  launchAgentId: string | undefined;
  projectId: string | null | undefined;
}): boolean {
  if (!input.launchAgentId) return false;
  if (!exitSnapshotEnabled) return false;
  if (input.projectId && excludedProjectIds.has(input.projectId)) return false;
  return true;
}

/** Test-only reset so suites don't leak module-level state across cases. */
export function _resetExitSnapshotConfig(): void {
  exitSnapshotEnabled = false;
  excludedProjectIds = new Set<string>();
}
