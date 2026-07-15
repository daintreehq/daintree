/**
 * Option+Arrow word navigation for terminal panes.
 *
 * xterm's default mapping for Option+Left/Right is the CSI modifier arrow
 * (`ESC [ 1 ; 3 D` / `C`), which neither zsh's ZLE nor bash's readline binds to
 * word motion — so the keys do nothing in a default shell. Both bind the meta
 * sequences `ESC b` / `ESC f` to backward-word/forward-word out of the box, so
 * XtermAdapter substitutes those. `macOptionIsMeta` doesn't cover this: it only
 * applies to character keys, never arrows.
 *
 * Pure over the event. The two gates live at the call site: macOS, because
 * remapping Alt+Arrow is a Mac convention (VS Code gates its equivalent on
 * `isMac` too), and the normal buffer, because a full-screen TUI decodes the CSI
 * modifier arrows itself and would only be confused by a Meta+B/F.
 */
const META_BACKWARD_WORD = "\x1bb";
const META_FORWARD_WORD = "\x1bf";

/** The only fields the mapping reads — `code` is excluded so a remapped or
 *  assistive-tech key can't be matched by its physical position. */
export type WordJumpKeyEvent = Pick<
  KeyboardEvent,
  "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/**
 * The meta sequence Option+Left/Right should emit, or `null` when the event
 * isn't a bare Option+Arrow.
 *
 * Every other modifier is excluded deliberately: Cmd+Option+Arrow is bound to
 * the `terminal.focus*` pane navigation actions, and Shift+Option+Arrow is the
 * selection-extend convention.
 */
export function getOptionWordJumpSequence(event: WordJumpKeyEvent): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowLeft") return META_BACKWARD_WORD;
  if (event.key === "ArrowRight") return META_FORWARD_WORD;
  return null;
}
