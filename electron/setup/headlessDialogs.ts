import type { Dialog, MessageBoxOptions } from "electron";

/**
 * A headless Host has no display, and Chromium crashes on any native dialog
 * there (message box, error box or file picker), ending every terminal and
 * agent the host runs. Nobody is at that screen to answer one anyway, so each
 * is logged and answered as cancelled.
 */

/** The button a person would have reached for to back out, by Electron's own rule. */
export function cancelledResponse(options: MessageBoxOptions): number {
  if (typeof options.cancelId === "number") return options.cancelId;
  const index = (options.buttons ?? []).findIndex((label) => /^(cancel|no)$/i.test(label.trim()));
  return index >= 0 ? index : 0;
}

/** The options of a call made as (window, options) or (options). */
function optionsOf<T>(first: unknown, second: unknown): T {
  return (second ?? first) as T;
}

export function installHeadlessDialogGuards(
  dialog: Dialog,
  log: (message: string) => void = (message) => console.warn(message)
): void {
  const refused = (kind: string, text: string | undefined) =>
    log(`[Headless] No display for a ${kind}; answered as cancelled: ${text ?? ""}`);

  dialog.showMessageBox = (async (first: unknown, second?: unknown) => {
    const options = optionsOf<MessageBoxOptions>(first, second);
    refused("message box", options.message);
    return { response: cancelledResponse(options), checkboxChecked: false };
  }) as Dialog["showMessageBox"];
  dialog.showMessageBoxSync = ((first: unknown, second?: unknown) => {
    const options = optionsOf<MessageBoxOptions>(first, second);
    refused("message box", options.message);
    return cancelledResponse(options);
  }) as Dialog["showMessageBoxSync"];
  dialog.showErrorBox = (title: string, content: string) => {
    log(`[Headless] No display for an error box: ${title}: ${content}`);
  };
  dialog.showOpenDialog = (async (first: unknown, second?: unknown) => {
    refused("file picker", optionsOf<{ title?: string }>(first, second).title);
    return { canceled: true, filePaths: [] };
  }) as Dialog["showOpenDialog"];
  dialog.showOpenDialogSync = ((first: unknown, second?: unknown) => {
    refused("file picker", optionsOf<{ title?: string }>(first, second).title);
    return undefined;
  }) as Dialog["showOpenDialogSync"];
  dialog.showSaveDialog = (async (first: unknown, second?: unknown) => {
    refused("save dialog", optionsOf<{ title?: string }>(first, second).title);
    return { canceled: true, filePath: "" };
  }) as Dialog["showSaveDialog"];
  dialog.showSaveDialogSync = ((first: unknown, second?: unknown) => {
    refused("save dialog", optionsOf<{ title?: string }>(first, second).title);
    return "";
  }) as Dialog["showSaveDialogSync"];
}
