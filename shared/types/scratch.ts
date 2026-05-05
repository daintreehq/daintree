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
}
