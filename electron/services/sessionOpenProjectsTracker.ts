/**
 * Keeps the persisted session-open checkpoint in step with the projects the
 * user actually has open, and freezes the previous session's copy of it for the
 * switcher's recently-active dot (#11794).
 *
 * Two sets, and the split is the whole point:
 *
 *  - `previous` is the checkpoint as it was read off disk at boot, frozen with
 *    the launch time. Nothing this session does may change it — the dot means
 *    "you had this open last time", so a project opened during THIS session
 *    must not join it.
 *  - `current` is what this session has open, a deduplicated union across every
 *    window. It starts empty, and the boot read that produced `previous`
 *    cleared the stored row on its way past, so membership never carries over
 *    and a session that opens nothing leaves an empty set behind.
 *
 * Continuous persistence rather than a snapshot at quit, for the same reason
 * the window manifest does it (#11492): our own force-quit goes through
 * `app.exit(0)`, which skips `before-quit`, and a main-process crash skips
 * everything. Those are exactly the exits after which you want the set back.
 *
 * No shutdown gate, unlike openWindowsTracker: every mutator here is reached
 * from a ProjectStore method that has already written the same shared database
 * on the line before, so a write during teardown cannot be the call that
 * reopens a closed connection.
 *
 * Membership is NOT residency. `ProjectViewManager` evicts views under memory
 * pressure, and that is a decision the user never sees — it must not silently
 * drop a project out of the set.
 *
 * Recovery launches read but never write. Safe mode opens one window on
 * purpose; rolling the checkpoint over there would overwrite the user's real
 * set with it, the same reason openWindowsTracker goes read-only on that path.
 *
 * Electron-free and DB-free by construction: the writer is injected. That keeps
 * the module importable from ProjectStore's node-environment unit suites, where
 * it is simply never initialized and every mutator is a no-op.
 */

export interface PreviousSessionOpenProjects {
  /** When this launch captured the set, the anchor for the dot's deadline. */
  readonly atMs: number;
  readonly projectIds: ReadonlySet<string>;
}

export type SessionOpenProjectsWriter = (projectIds: ReadonlySet<string>) => void;

interface TrackerState {
  previous: PreviousSessionOpenProjects;
  current: Set<string>;
  /** Recovery launches observe but never write. */
  readOnly: boolean;
  write: SessionOpenProjectsWriter;
  /**
   * A write failed, so the stored value no longer matches `current`. Set here
   * rather than swallowed, so the next mutation persists the full set even when
   * it would otherwise be a no-op (re-adding a project already in the union).
   */
  dirty: boolean;
}

let state: TrackerState | null = null;

/**
 * Freeze the previous session's set and start tracking this one.
 *
 * Performs no write, and needs none: the boot-path read that produced
 * `previousSessionProjectIds` also cleared the stored row, so disk already
 * reads as "nothing open this session" and every later add/remove keeps it in
 * step. Writing here instead would force the shared database — and its drizzle
 * migrations — open ahead of the first window.
 */
export function initSessionOpenProjectsTracker(opts: {
  previousSessionProjectIds: Iterable<string>;
  launchAtMs: number;
  readOnly: boolean;
  write: SessionOpenProjectsWriter;
}): void {
  state = {
    previous: {
      atMs: opts.launchAtMs,
      projectIds: new Set(opts.previousSessionProjectIds),
    },
    current: new Set(),
    readOnly: opts.readOnly,
    write: opts.write,
    dirty: false,
  };
}

/**
 * The previous session's open set, or null when this process never captured one
 * — a unit suite, or a boot path that failed before the read. Null means no
 * project gets a launch-clock deadline, which is the safe direction: the dot is
 * a hint, and being absent costs less than marking projects that were closed.
 */
export function getPreviousSessionOpenProjects(): PreviousSessionOpenProjects | null {
  return state?.previous ?? null;
}

function persist(): void {
  if (!state || state.readOnly) return;
  try {
    state.write(state.current);
    state.dirty = false;
  } catch (error) {
    // Losing the checkpoint costs the user some grey dots next launch. It must
    // never take down a project switch, a close, or a project deletion.
    state.dirty = true;
    console.warn("[sessionOpenProjects] Failed to persist the session-open checkpoint:", error);
  }
}

/** A project the user opened or switched to joins the session's set. */
export function addSessionOpenProject(projectId: string): void {
  if (!state || !projectId) return;
  if (state.current.has(projectId) && !state.dirty) return;
  state.current.add(projectId);
  persist();
}

/** A project the user closed, removed, or that went missing leaves the set. */
export function removeSessionOpenProject(projectId: string): void {
  if (!state || !projectId) return;
  const removed = state.current.delete(projectId);
  if (!removed && !state.dirty) return;
  persist();
}

/** Test-only: the module singleton outlives tests that don't reset modules. */
export function resetSessionOpenProjectsTrackerForTests(): void {
  state = null;
}
