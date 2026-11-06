import { Annotation } from "@codemirror/state";

/**
 * Marks an edit of the user's that no CodeMirror user event names: a chip's
 * remove control or Backspace, a paste or attachment the composer inserts
 * itself, a completion. Words still being corrected refuse it as they refuse
 * typing (`pendingLock`). An annotation rather than a user event, so the
 * consumers that read user events see these edits as before.
 */
export const userEdit = Annotation.define<true>();
