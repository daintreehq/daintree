import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { isScratchpadElement } from "@/lib/terminalScratchpad";

/**
 * Hands the keyboard back to the pane when the user is writing in its
 * Scratchpad and the strip is about to unmount; otherwise focus would fall to
 * `document.body`. Must run before the collapse, while the editor still exists.
 *
 * Focus leaves the Scratchpad first: the pane's focus grabs deliberately stand
 * down while the notes hold the keyboard (#12835), so they would refuse a
 * handoff made while it still does. `force` is for the Hide button, which may
 * not have taken focus on click.
 */
export function returnFocusFromScratchpad(terminalId: string, force = false): void {
  const active = document.activeElement;
  const inside = isScratchpadElement(active, terminalId);
  if (!inside && !force) return;
  if (inside && active instanceof HTMLElement) active.blur();
  focusPanelInput(terminalId);
}
