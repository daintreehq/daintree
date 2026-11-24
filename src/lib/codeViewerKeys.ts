import { isMac } from "@/lib/platform";

/**
 * Marks the code viewer's root. The viewer's find bar and go-to-line field
 * live inside it, so it covers every place the viewer's keys are typed.
 */
export const CODE_VIEWER_OWNER_ATTR = "data-code-viewer";

/**
 * The viewer's go to line is CodeMirror's `Mod-l`, which is also the Assistant
 * toggle's default combo. The window capture handler runs before CodeMirror
 * sees the key, so with the keyboard inside a viewer it has to stand down or
 * go to line never opens.
 */
export function codeViewerOwnsKey(event: KeyboardEvent, target: Element): boolean {
  const primary = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.shiftKey || event.altKey || event.key.toLowerCase() !== "l") return false;
  return target.closest(`[${CODE_VIEWER_OWNER_ATTR}]`) !== null;
}
