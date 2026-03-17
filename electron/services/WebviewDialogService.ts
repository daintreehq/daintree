import { webContents } from "electron";

type DialogCallback = (success: boolean, response?: string) => void;

interface PendingDialog {
  callback: DialogCallback;
  webContentsId: number;
  panelId: string;
}

class WebviewDialogService {
  private panelMap = new Map<number, string>();
  private pendingDialogs = new Map<string, PendingDialog>();
  private destroyedListeners = new Set<number>();

  registerPanel(webContentsId: number, panelId: string): void {
    this.panelMap.set(webContentsId, panelId);

    if (!this.destroyedListeners.has(webContentsId)) {
      this.destroyedListeners.add(webContentsId);
      const wc = webContents.fromId(webContentsId);
      if (wc && !wc.isDestroyed()) {
        wc.once("destroyed", () => {
          this.cancelPendingForGuest(webContentsId);
          this.panelMap.delete(webContentsId);
          this.destroyedListeners.delete(webContentsId);
        });
      }
    }
  }

  getPanelId(webContentsId: number): string | undefined {
    return this.panelMap.get(webContentsId);
  }

  registerDialog(
    dialogId: string,
    webContentsId: number,
    callback: DialogCallback
  ): string | undefined {
    const panelId = this.panelMap.get(webContentsId);
    if (!panelId) return undefined;

    this.pendingDialogs.set(dialogId, { callback, webContentsId, panelId });
    return panelId;
  }

  resolveDialog(dialogId: string, confirmed: boolean, response?: string): void {
    const pending = this.pendingDialogs.get(dialogId);
    if (!pending) return;

    this.pendingDialogs.delete(dialogId);
    pending.callback(confirmed, response);
  }

  private cancelPendingForGuest(webContentsId: number): void {
    for (const [dialogId, pending] of this.pendingDialogs) {
      if (pending.webContentsId === webContentsId) {
        this.pendingDialogs.delete(dialogId);
        try {
          pending.callback(false);
        } catch {
          // Guest may already be gone
        }
      }
    }
  }
}

let instance: WebviewDialogService | null = null;

export function getWebviewDialogService(): WebviewDialogService {
  if (!instance) {
    instance = new WebviewDialogService();
  }
  return instance;
}
