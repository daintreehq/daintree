/**
 * The startup window-restore fan-out (#11492).
 *
 * Extracted from main.ts's `whenReady()` block so the ordering rules below can
 * be tested — main.ts itself is not importable in a unit test, and these are
 * exactly the rules that are silent when they break: you don't find out the
 * fleet stopped restoring until the next relaunch.
 */

import { parseHostScopedKey } from "../../shared/types/remoteHosts.js";
import {
  isRemoteWorkspaceKey,
  type OpenWindowRecord,
} from "../services/persistence/windowManifest.js";

/**
 * What `createWindow` reports back. "exit-requested" stops the restore; any
 * other non-"ok" result marks it unclean but lets the remaining windows follow.
 */
export type CreateWindowResult = "ok" | "exit-requested" | "not-registered";

/**
 * How long a restoring window may hold up the next one while its renderer
 * hydrates. Pacing, not a correctness gate: past this the next window starts
 * anyway, so one stuck renderer cannot strand the rest of the fleet.
 */
export const RESTORE_HYDRATION_WAIT_MS = 30_000;

/**
 * How long one background window may hold the restore queue in total, setup
 * included. Setup can wait on a workspace host that never reports ready, and
 * a sequential queue must not let that strand every window behind it: past
 * this the next window starts while the slow one finishes on its own.
 */
export const RESTORE_WINDOW_STALL_MS = 90_000;

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
    opts?: {
      revealMode?: "show" | "showInactive";
      /** Further projects this window had live, most-recently-used first (#12320). */
      backgroundProjectIds?: readonly string[];
      /**
       * Resolve only once the window's renderer reports it has hydrated, or
       * this many ms pass. Set for every window another one is queued behind.
       */
      awaitHydrationMs?: number;
      /**
       * The window was showing this host-scoped workspace (`<hostId>:<projectId>`).
       * It opens on this machine (`projectId` is undefined, a picker) and is
       * switched to the host once Remote Hosts is up.
       */
      remoteWorkspaceKey?: string;
    }
  ) => Promise<CreateWindowResult>;
  suppressSaves: () => void;
  resumeSaves: (persistNow: boolean) => void;
  onBackgroundWindowFailed: (reason: unknown) => void;
  /**
   * Whether a live window already holds a view of the project. The primary
   * window is usable before the rest of the fleet is created, and a saved
   * project the user opens there in the meantime must not get a second window.
   */
  isProjectOwned?: (projectId: string) => boolean;
  /**
   * Whether the app has begun shutting down. A quit does not surface as a
   * createWindow result, so the queue checks before starting each window.
   */
  isShuttingDown?: () => boolean;
  /**
   * A window is already up, so every record is a background window (#12801).
   * Set when a single-crash recovery brings the rest of the fleet back behind
   * the recovery window: no primary is created, nothing takes focus, and an
   * empty manifest opens nothing.
   */
  primaryAlreadyOpen?: boolean;
  /**
   * The restore brings back windows or background projects on these hosts.
   * Called once the focused window is up (global init has settled), before
   * the rest of the fleet, so their dials don't wait on local windows (#15888).
   */
  onRemoteHostsNeeded?: (hostIds: string[]) => void;
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
  if (records.length > 0) return localSeedOf(records[0]);
  if (hadManifest) return undefined;
  return fallbackProjectId;
}

/** The host-scoped workspace a record names, when it was on another machine's project. */
function remoteKeyOf(record: OpenWindowRecord | undefined): string | undefined {
  const id = record?.projectId;
  return id && isRemoteWorkspaceKey(id) ? id : undefined;
}

/**
 * What the window opens with on this machine: its own workspace, or a picker
 * for one that was on a host (the switch to the host follows once it's up).
 */
function localSeedOf(record: OpenWindowRecord): string | undefined {
  return remoteKeyOf(record) ? undefined : (record.projectId ?? undefined);
}

/** Each host a record names, as its window's workspace or a background project. */
function hostsNamedBy(records: readonly OpenWindowRecord[]): string[] {
  const hostIds = new Set<string>();
  for (const { projectId, backgroundProjectIds } of records) {
    for (const id of [projectId, ...(backgroundProjectIds ?? [])]) {
      if (id && isRemoteWorkspaceKey(id)) hostIds.add(parseHostScopedKey(id).hostId);
    }
  }
  return [...hostIds];
}

/** The create option carrying a host-scoped workspace, or nothing for a local one. */
function remoteRestoreOpts(record: OpenWindowRecord | undefined): {
  remoteWorkspaceKey?: string;
} {
  const key = remoteKeyOf(record);
  return key ? { remoteWorkspaceKey: key } : {};
}

/**
 * What `createWindow` is given to bring a window back from its record. Shared
 * by the launch restore and an OOM recreation (#15564), so a host-scoped
 * workspace comes back the same way from both: a picker on this machine that
 * moves to the host, never a local project that happens to share its id.
 */
export function windowRestoreArgs(record: OpenWindowRecord): {
  projectId: string | undefined;
  options: { remoteWorkspaceKey?: string; backgroundProjectIds?: readonly string[] };
} {
  return {
    projectId: localSeedOf(record),
    options: { ...remoteRestoreOpts(record), backgroundProjectIds: record.backgroundProjectIds },
  };
}

/**
 * Collapse the manifest to one live view per workspace across the whole fleet
 * (#12596). A manifest saved before that rule existed can name one project in
 * two windows, and restoring it verbatim would rebuild the duplicate: two views
 * attached to the same PTYs and an MCP binding that fails closed as ambiguous.
 *
 * Foreground claims run first, in focus order, so a project one window was
 * showing is never lost to another window that merely had it warm. A window
 * whose own project an earlier window already claimed is dropped rather than
 * reopened on a picker, and its background list folds into the window that kept
 * the project — those can be projects whose agents are still running, and
 * dropping them would skip their restore. Picker windows (`null`) never collide.
 */
export function normalizeWindowRecords(records: readonly OpenWindowRecord[]): OpenWindowRecord[] {
  const kept: OpenWindowRecord[] = [];
  const keeperByProject = new Map<string, number>();
  const folded = new Map<number, string[]>();

  for (const record of records) {
    const { projectId } = record;
    if (projectId !== null) {
      const keeper = keeperByProject.get(projectId);
      if (keeper !== undefined) {
        if (record.backgroundProjectIds?.length) {
          folded.set(keeper, [...(folded.get(keeper) ?? []), ...record.backgroundProjectIds]);
        }
        continue;
      }
      keeperByProject.set(projectId, kept.length);
    }
    kept.push(record);
  }

  const claimed = new Set(keeperByProject.keys());
  return kept.map((record, index) => {
    const candidates = [...(record.backgroundProjectIds ?? []), ...(folded.get(index) ?? [])];
    const backgroundProjectIds = candidates.filter((id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    });
    const unchanged =
      backgroundProjectIds.length === (record.backgroundProjectIds?.length ?? 0) &&
      !folded.has(index);
    if (unchanged) return record;
    return backgroundProjectIds.length > 0
      ? { projectId: record.projectId, backgroundProjectIds }
      : { projectId: record.projectId };
  });
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
 *     init has fully settled and the rest can follow.
 *  2. Saves stay suppressed until the whole fan-out settles, and the manifest
 *     is only rewritten if EVERY window came up. A half-restored fleet must not
 *     overwrite a manifest that is still correct on disk — the next launch would
 *     then restore only the windows that happened to survive this one.
 */
export async function restoreWindowFleet(deps: RestoreWindowFleetDeps): Promise<void> {
  const records = normalizeWindowRecords(deps.records);
  const primaryProjectId = resolvePrimaryRestoreProjectId(
    records,
    deps.hadManifest,
    deps.fallbackProjectId
  );

  deps.suppressSaves();
  let restoredCleanly = false;
  try {
    // The primary window carries its own background list too. Its projects are
    // the ones the user was closest to, and the queue that consumes these is
    // global and ordered, so handing them over first is what makes "the project
    // I was in paints first, the rest fill in behind it" hold across windows.
    const background = deps.primaryAlreadyOpen ? records : records.slice(1);
    if (!deps.primaryAlreadyOpen) {
      const primaryResult = await deps.createWindow(primaryProjectId, {
        ...remoteRestoreOpts(records[0]),
        backgroundProjectIds: records[0]?.backgroundProjectIds,
        ...(background.length > 0 ? { awaitHydrationMs: RESTORE_HYDRATION_WAIT_MS } : {}),
      });
      if (primaryResult !== "ok") return;
    }

    const hostIds = hostsNamedBy(records);
    if (hostIds.length > 0) deps.onRemoteHostsNeeded?.(hostIds);

    let backgroundClean = true;
    // Background windows come up one at a time, each waiting for the last to
    // finish its services and hydrate its renderer. Starting them all at once
    // put every window's host fork, git scan and terminal restore in the same
    // burst, competing with the window the user is actually looking at
    // (#12800). Every window still restores without waiting on focus; the
    // waits are bounded, so a slow window delays the rest rather than
    // stranding them.
    for (const [index, record] of background.entries()) {
      if (deps.isShuttingDown?.()) {
        backgroundClean = false;
        break;
      }
      // Checked per window, not once up front: a window whose project is live
      // already is one the user has since opened, and the longer a sequential
      // restore runs the more likely that becomes.
      if (record.projectId !== null && deps.isProjectOwned?.(record.projectId)) continue;
      // Background windows reveal with showInactive(): a plain show() would
      // pull focus away from the window the user is working in.
      const { projectId, options } = windowRestoreArgs(record);
      const created = deps.createWindow(projectId, {
        ...options,
        revealMode: "showInactive",
        ...(index < background.length - 1 ? { awaitHydrationMs: RESTORE_HYDRATION_WAIT_MS } : {}),
      });
      let result: CreateWindowResult | "stalled";
      try {
        result = await settleWithin(created, RESTORE_WINDOW_STALL_MS);
      } catch (error) {
        deps.onBackgroundWindowFailed(error);
        backgroundClean = false;
        continue;
      }
      if (result === "stalled") {
        // Still coming up, just not in time to hold the queue. Its eventual
        // outcome no longer decides anything, but a failure is still reported.
        created.catch(deps.onBackgroundWindowFailed);
        backgroundClean = false;
        continue;
      }
      if (result === "exit-requested") {
        // The process is going away; building more windows into it would only
        // delay the exit.
        backgroundClean = false;
        break;
      }
      if (result !== "ok") backgroundClean = false;
    }

    restoredCleanly = backgroundClean;
  } finally {
    deps.resumeSaves(restoredCleanly);
  }
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<"stalled">((resolve) => {
    timer = setTimeout(() => resolve("stalled"), ms);
  });
  try {
    return await Promise.race([promise, stalled]);
  } finally {
    clearTimeout(timer);
  }
}
