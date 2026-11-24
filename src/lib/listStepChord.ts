import type { KeyboardEvent } from "react";
import { isMac } from "@/lib/platform";

/** What of a key press the step reads. */
export type ListStepKey = Pick<
  KeyboardEvent<Element>,
  "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey" | "keyCode"
> & { nativeEvent: Pick<globalThis.KeyboardEvent, "isComposing"> };

/**
 * ⌘↑/⌘↓ on macOS, Alt+↑/↓ elsewhere (Slack's channel switch): the item above
 * or below in a list, from anywhere in the surface that shows it. Ctrl+↑/↓ is
 * not used off the Mac because terminals send it to the program as its own key.
 */
export function listStepOf(event: ListStepKey): -1 | 1 | null {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  // An input method's own keys: stepping would unmount what it is composing in.
  if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey) return null;
  const chord = isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  return event.key === "ArrowUp" ? -1 : 1;
}
