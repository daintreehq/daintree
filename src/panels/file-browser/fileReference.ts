import { formatAtFileToken } from "@/components/Terminal/hybridInputParsing";

/**
 * The file browser's "insert a file reference into an agent" gesture (#11577).
 *
 * Deliberately not a registered keybinding. The command is only meaningful
 * while a particular file tree owns focus and knows its active row, and the
 * global registry dispatches in capture phase before any tree could supply
 * one — an action would have to re-infer the focused browser, its worktree and
 * its base path. `FileTreeView`'s local Shift+F10 row-menu case is the
 * precedent for a gesture scoped to the tree itself.
 *
 * `Cmd+I` is free across the shipped bindings: `Cmd+Shift+I` is
 * `terminal.inject` and the `Cmd+Alt+*` family is agent/panel navigation.
 */
export const INSERT_FILE_REFERENCE_COMBO = "Cmd+I";

/**
 * Does this keydown mean "insert a file reference"?
 *
 * Cmd on macOS, Ctrl elsewhere — the same fold `combosFieldsEqual` applies for
 * conflict detection. Shift and Alt must be absent rather than ignored, so
 * `Cmd+Shift+I` keeps reaching `terminal.inject` instead of firing both.
 */
export function matchesInsertFileReferenceCombo(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean
): boolean {
  if (event.key.toLowerCase() !== "i") return false;
  if (event.shiftKey || event.altKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Append an `@file` reference to a hybrid-input draft.
 *
 * Appends rather than inserting at a cursor: the gesture fires from the file
 * browser, which has no view of where the caret sits in a sibling panel's
 * editor. Mirrors the hybrid drop path (`useDragDrop`) otherwise — the same
 * `formatAtFileToken` token followed by a trailing space, so the next
 * reference or typed word never fuses onto it.
 *
 * Duplicates are preserved. The chip extensions already handle a repeated
 * path deliberately, and swallowing the second insert would make the gesture
 * look broken when the user meant to reference a file twice.
 */
export function appendFileReference(draft: string, absolutePath: string): string {
  const token = formatAtFileToken(absolutePath);
  // Only add the separator the draft is missing: trailing whitespace the user
  // typed is theirs, and normalizing it would move their caret's worth of
  // spacing for no reason.
  const separator = draft === "" || /\s$/.test(draft) ? "" : " ";
  return `${draft}${separator}${token} `;
}
