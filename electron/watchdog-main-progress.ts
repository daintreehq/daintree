// eager-import-allow: stats main's own files via sync fs in the watchdog host
import type { MainProgressObserver } from "./watchdog-host-core.js";

/**
 * Files only main writes, relative to userData (#14367): the crash marker
 * (a heartbeat every minute) and the session backup. `logs/daintree.log` is
 * left out on purpose — the pty and workspace hosts append to it too, so it
 * moves while main is wedged.
 */
export const MAIN_PROGRESS_FILES = ["running.lock", "backups/session-state.json"] as const;

export interface FileFingerprint {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface MainProgressObserverDeps {
  paths: readonly string[];
  /** Null when the file is missing or unreadable. Must not throw. */
  stat: (path: string) => FileFingerprint | null;
}

/**
 * Credits a change only between two readings of the same file: a file that
 * appears, disappears or can't be read earns nothing, and neither does the
 * first reading after a reset.
 */
export function createMainProgressObserver(deps: MainProgressObserverDeps): MainProgressObserver {
  let baseline: Array<FileFingerprint | null> | null = null;

  return {
    observe(): boolean {
      const current = deps.paths.map((p) => deps.stat(p));
      const previous = baseline;
      baseline = current;
      if (previous === null) return false;
      return current.some((fp, i) => {
        const before = previous[i];
        if (!fp || !before) return false;
        return (
          fp.ino !== before.ino ||
          fp.size !== before.size ||
          fp.mtimeMs > before.mtimeMs ||
          fp.ctimeMs > before.ctimeMs
        );
      });
    },
    reset(): void {
      baseline = null;
    },
  };
}
