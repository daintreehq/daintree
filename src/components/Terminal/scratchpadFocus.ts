import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { isScratchpadElement } from "@/lib/terminalScratchpad";

/**
 * Hands the keyboard back to the pane when the user is writing in its
 * Scratchpad and the strip is about to unmount; otherwise focus would fall to
 * `document.body`. Must run before the collapse, while the editor still exists.
 */
export function returnFocusFromScratchpad(terminalId: string): void {
  if (!isScratchpadElement(document.activeElement, terminalId)) return;
  focusPanelInput(terminalId);
}
