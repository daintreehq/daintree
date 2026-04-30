/**
 * Dependency-free disk-pressure flag shared between `DiskSpaceMonitor` (writer)
 * and non-critical Tier 2 writers (logger, telemetry, frecency, caches) that
 * need to drop writes when free space is below the critical threshold.
 *
 * Kept in its own module so writers can read the flag without importing
 * `DiskSpaceMonitor` (which itself imports `logger.ts`, creating a cycle).
 *
 * Scope: this module is per-process. `DiskSpaceMonitor` only runs in the main
 * process, so utility processes (pty-host, workspace-host) keep their copy of
 * `writesSuppressed` at `false` and continue writing. Forwarding the flag to
 * those processes is a follow-up — issue #6271 only covers main-process
 * writers.
 */

let writesSuppressed = false;

export function getWritesSuppressed(): boolean {
  return writesSuppressed;
}

export function setWritesSuppressed(value: boolean): void {
  writesSuppressed = value;
}

export function resetWritesSuppressedForTesting(): void {
  writesSuppressed = false;
}
