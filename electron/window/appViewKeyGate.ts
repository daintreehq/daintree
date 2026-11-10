import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { findTerminalCycleAction, keepsKeyFromMenu } from "../services/menuAccelerators.js";

/**
 * Every app view's before-input-event, the Canopy window's included: the
 * terminal cycle shortcuts (Ctrl+Tab by default) go to the renderer as menu
 * actions, and the keys `keepsKeyFromMenu` names are kept from the native menu
 * for this one event, so the renderer's KeybindingService (scopes, priorities,
 * rebinds, terminal-reserved keys) owns them while it has focus. The native
 * items stay clickable and registered, which keeps the shortcuts working when
 * focus is in a guest webview or DevTools, where this never runs.
 */
export function gateAppViewKey(
  webContents: WebContents,
  event: Electron.Event,
  input: Electron.Input
): void {
  const terminalCycleAction = findTerminalCycleAction(input);
  if (terminalCycleAction) {
    event.preventDefault();
    webContents.send(CHANNELS.MENU_ACTION, terminalCycleAction);
    return;
  }
  webContents.setIgnoreMenuShortcuts(keepsKeyFromMenu(input));
}
