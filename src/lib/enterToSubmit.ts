import type React from "react";

/** Single-line inputs, where Enter has no editing meaning of its own. */
const SUBMITTING_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "number",
  "password",
  "tel",
]);

/**
 * A plain Enter in a single-line field of a form dialog — the key every form
 * dialog answers with its primary action, as a native form would.
 *
 * Not a textarea (Enter is a newline), a select or a checkbox (Enter has its own
 * meaning there), a modified Enter (Cmd/Ctrl+Enter is a dialog's explicit submit
 * shortcut where it has one, Shift+Enter is never a submit), or a keystroke that
 * is committing an IME composition — `keyCode` 229 covers the browsers that
 * report the commit after `isComposing` has already cleared.
 */
export function isEnterToSubmit(event: React.KeyboardEvent): boolean {
  if (event.key !== "Enter") return false;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const target = event.target;
  return target instanceof HTMLInputElement && SUBMITTING_INPUT_TYPES.has(target.type);
}
