/**
 * Scratch workspace — a throwaway, app-managed folder for one-off agent tasks.
 * Parallel to `Project` rather than a subtype: separate table, store, IPC
 * namespace, and lifecycle. Folders live in a UUID-named path under the app's
 * `userData` directory so they don't pollute the user's project folders.
 */
export interface Scratch {
  /** UUID v4 — both identifier and path component under userData/scratches/. */
  id: string;
  /** Absolute filesystem path of the scratch workspace folder. */
  path: string;
  /** User-editable display name. */
  name: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last opened timestamp (ms since epoch); used for sort order within the section. */
  lastOpened: number;
  /**
   * Acknowledgement watermark for completed agents, mirroring the project
   * field. Completions at or before this stamp stop counting toward the row's
   * "ready for review" state. Absent until the user has dwelled on the scratch
   * with a completion on screen.
   */
  lastCompletionSeenAt?: number;
  /**
   * How many saved agent panels this scratch would restore if opened (#11821),
   * mirroring the project field. Main derives it from the persisted state, so
   * the switcher row draws its resume dot without reading anything.
   *
   * Absent means main has not resolved this scratch yet, which is not the same
   * as resolving it to 0: an unresolved row makes no claim rather than a wrong
   * one. Main's to set — never something a renderer may assert.
   */
  resumableAgentCount?: number;
}
