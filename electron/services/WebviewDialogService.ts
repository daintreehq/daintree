import { webContents } from "electron";

type DialogCallback = (success: boolean, response?: string) => void;

interface PendingDialog {
  callback: DialogCallback;
  webContentsId: number;
  panelId: string;
}

type SessionStorageEntry = [string, string];

class WebviewDialogService {
  private panelMap = new Map<number, string>();
  private kindMap = new Map<number, string>();
  private pendingDialogs = new Map<string, PendingDialog>();
  private pendingOAuthSessionStorage = new Map<string, Promise<SessionStorageEntry[]>>();
  private destroyedListeners = new Set<number>();

  registerPanel(webContentsId: number, panelId: string, kind?: string): void {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      this.panelMap.delete(webContentsId);
      this.kindMap.delete(webContentsId);
      this.destroyedListeners.delete(webContentsId);
      return;
    }

    const previousPanelId = this.panelMap.get(webContentsId);
    if (previousPanelId && previousPanelId !== panelId) {
      this.pendingOAuthSessionStorage.delete(previousPanelId);
      // Drop a stale kind when the webContents is rebound to a different panel;
      // the new owner re-supplies it on its own registration.
      this.kindMap.delete(webContentsId);
    }

    this.panelMap.set(webContentsId, panelId);
    // A remount (LRU restore, partition change, dev double-mount) registers a
    // new webContentsId for the same panelId before the old guest fires
    // `destroyed`. Drop the stale duplicate now so the reverse lookup
    // (getWebContentsId) resolves to the live webview rather than the
    // torn-down one, whose capturePage() would return the old page's pixels.
    for (const [otherWebContentsId, mappedPanelId] of this.panelMap) {
      if (mappedPanelId === panelId && otherWebContentsId !== webContentsId) {
        this.panelMap.delete(otherWebContentsId);
        this.kindMap.delete(otherWebContentsId);
      }
    }
    // Registration happens from multiple effects (dialog + console capture);
    // only some pass a kind. Preserve a previously-set kind when omitted.
    if (kind !== undefined) {
      this.kindMap.set(webContentsId, kind);
    }

    if (!this.destroyedListeners.has(webContentsId)) {
      this.destroyedListeners.add(webContentsId);
      wc.once("destroyed", () => {
        this.cancelPendingForGuest(webContentsId);
        const panelId = this.panelMap.get(webContentsId);
        if (panelId) {
          this.pendingOAuthSessionStorage.delete(panelId);
        }
        this.panelMap.delete(webContentsId);
        this.kindMap.delete(webContentsId);
        this.destroyedListeners.delete(webContentsId);
      });
    }
  }

  getPanelId(webContentsId: number): string | undefined {
    return this.panelMap.get(webContentsId);
  }

  getPanelKind(webContentsId: number): string | undefined {
    return this.kindMap.get(webContentsId);
  }

  /**
   * Reverse of {@link getPanelId}: resolve a panel's live webContentsId from its
   * panel id. `panelMap` is keyed by webContentsId, so this is an O(n) scan —
   * negligible at the handful-of-webview-panels scale it runs at. Returns the
   * first match; a webContents is rebound to at most one panel at a time.
   */
  getWebContentsId(panelId: string): number | undefined {
    for (const [webContentsId, mappedPanelId] of this.panelMap) {
      if (mappedPanelId === panelId) return webContentsId;
    }
    return undefined;
  }

  registerDialog(
    dialogId: string,
    webContentsId: number,
    callback: DialogCallback
  ): string | undefined {
    const panelId = this.panelMap.get(webContentsId);
    if (!panelId) return undefined;

    const previous = this.pendingDialogs.get(dialogId);
    if (previous) {
      this.pendingDialogs.delete(dialogId);
      try {
        previous.callback(false);
      } catch {
        // Ignore stale callback failures when superseding a dialog id.
      }
    }

    this.pendingDialogs.set(dialogId, { callback, webContentsId, panelId });
    return panelId;
  }

  resolveDialog(dialogId: string, confirmed: boolean, response?: string): void {
    const pending = this.pendingDialogs.get(dialogId);
    if (!pending) return;

    this.pendingDialogs.delete(dialogId);
    pending.callback(confirmed, response);
  }

  storeOAuthSessionStorage(
    panelId: string,
    entries: SessionStorageEntry[] | Promise<SessionStorageEntry[]>
  ): void {
    this.pendingOAuthSessionStorage.set(
      panelId,
      Promise.resolve(entries).then((resolved) =>
        resolved.filter(
          (entry): entry is SessionStorageEntry =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
        )
      )
    );
  }

  async consumeOAuthSessionStorage(panelId: string): Promise<SessionStorageEntry[]> {
    const pending = this.pendingOAuthSessionStorage.get(panelId);
    this.pendingOAuthSessionStorage.delete(panelId);
    if (!pending) return [];

    try {
      return await pending;
    } catch {
      return [];
    }
  }

  cancelPendingForGuest(webContentsId: number): void {
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
