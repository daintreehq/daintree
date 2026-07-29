/**
 * The startup window-restore fan-out (#11492).
 *
 * Extracted from main.ts's `whenReady()` block so the ordering rules below can
 * be tested — main.ts itself is not importable in a unit test, and these are
 * exactly the rules that are silent when they break: you don't find out the
 * fleet stopped restoring until the next relaunch.
 */

import type { OpenWindowRecord } from "../services/persistence/windowManifest.js";

/** What `createWindow` reports back. Anything but "ok" means: stop. */
export type CreateWindowResult = "ok" | "exit-requested" | "not-registered";

export interface RestoreWindowFleetDeps {
  /** Windows to restore, most-recently-focused first. Empty means one window. */
  records: OpenWindowRecord[];
  /**
   * Whether a stored manifest named at least one window — distinct from whether
   * any of those windows survived project-existence filtering. A manifest that
   * was stored naming zero windows reports false; see
   * `readOpenWindowsManifestSync`.
   */
  hadManifest: boolean;
  /**
   * The global last-active project, used ONLY when there was no manifest to
   * read. Never a substitute for a manifest whose projects were all deleted.
   */
  fallbackProjectId: string | undefined;
  createWindow: (
    projectId: string | undefined,
    opts?: { revealMode?: "show" | "showInactive" }
  ) => Promise<CreateWindowResult>;
  suppressSaves: () => void;
  resumeSaves: (persistNow: boolean) => void;
  onBackgroundWindowFailed: (reason: unknown) => void;
}

/**
 * Which project the focused window opens on.
 *
 * A manifest that named windows but filtered down to nothing resolves to
 * `undefined` — a project picker — never to `fallbackProjectId`. Falling back
 * there would open a project the user's window set never named, which is the
 * one outcome the issue rules out explicitly: a project that can no longer be
 * restored is skipped, never silently replaced by a different one.
 *
 * `hadManifest` is false both when nothing was stored and when what was stored
 * named zero windows, so closing every window still relaunches into the
 * last-active project rather than a picker.
 */
export function resolvePrimaryRestoreProjectId(
  records: OpenWindowRecord[],
  hadManifest: boolean,
  fallbackProjectId: string | undefined
): string | undefined {
  if (records.length > 0) return records[0].projectId ?? undefined;
  if (hadManifest) return undefined;
  return fallbackProjectId;
}

/**
 * Recreate the window set, then decide whether the result is worth persisting.
 *
 * Two orderings are load-bearing:
 *
 *  1. The first window is awaited ALONE. `initGlobalServices()` flips its
 *     "initialized" guard synchronously at entry, before its own awaits, so a
 *     concurrent second window sails straight past the guard and races the
 *     first window's migrations and DB open. Once this await returns, global
 *     init has fully settled and the rest are safe to run together.
 *  2. Saves stay suppressed until the whole fan-out settles, and the manifest
 *     is only rewritten if EVERY window came up. A half-restored fleet must not
 *     overwrite a manifest that is still correct on disk — the next launch would
 *     then restore only the windows that happened to survive this one.
 */
export async function restoreWindowFleet(deps: RestoreWindowFleetDeps): Promise<void> {
  const primaryProjectId = resolvePrimaryRestoreProjectId(
    deps.records,
    deps.hadManifest,
    deps.fallbackProjectId
  );

  deps.suppressSaves();
  let restoredCleanly = false;
  try {
    const primaryResult = await deps.createWindow(primaryProjectId);
    if (primaryResult !== "ok") return;

    let backgroundClean = true;
    if (deps.records.length > 1) {
      // Background windows reveal with showInactive(): they finish loading in
      // an unpredictable order, and a plain show() would hand focus to
      // whichever renderer parsed its skeleton last.
      const results = await Promise.allSettled(
        deps.records
          .slice(1)
          .map((record) =>
            deps.createWindow(record.projectId ?? undefined, { revealMode: "showInactive" })
          )
      );
      for (const result of results) {
        if (result.status === "rejected") {
          deps.onBackgroundWindowFailed(result.reason);
          backgroundClean = false;
        } else if (result.value !== "ok") {
          backgroundClean = false;
        }
      }
    }

    restoredCleanly = backgroundClean;
  } finally {
    deps.resumeSaves(restoredCleanly);
  }
}
