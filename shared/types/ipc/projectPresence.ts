/**
 * Where a project has a live view, as the project switcher sees it (#12597).
 *
 * `foreground`: the window is showing it. `activating`: the window has committed
 * to showing it but has no view yet. `cached`: the window holds a view it isn't
 * showing. The same three states the owner lookup behind a switch uses, so a
 * row's marker and where Enter actually goes are read off one rule.
 */
export type ProjectPresenceState = "foreground" | "activating" | "cached";

export interface ProjectPresenceEntry {
  projectId: string;
  windowId: number;
  state: ProjectPresenceState;
}

/**
 * Presence relative to the window that asked. Main does the split because only
 * main can tell which window a renderer belongs to — the renderer has no id for
 * its own window.
 *
 * Advisory: a switch re-checks ownership when it runs, so a stale snapshot costs
 * a wrong label, never a duplicate view.
 */
export interface ProjectPresenceSnapshot {
  /** Projects the requesting window holds a live view of, the current one included. */
  thisWindow: ProjectPresenceEntry[];
  /** Projects another window owns — one entry per project, the owner a switch would go to. */
  otherWindows: ProjectPresenceEntry[];
}
