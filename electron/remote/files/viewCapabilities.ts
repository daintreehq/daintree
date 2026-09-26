import crypto from "node:crypto";

/**
 * Preview capabilities: one unguessable token per remote view, minted by main
 * and carried in that view's host-scoped preview URLs. A protocol request
 * carries no sender, so this is how main knows which view (and so which of its
 * endpoints on the host) a preview runs for. A token dies with its view.
 */
export class ViewFileCapabilities {
  private readonly viewByToken = new Map<string, number>();
  private readonly byView = new Map<number, { token: string; unwatch: () => void }>();

  /** `watch` calls `onGone` once the view is destroyed and returns an unsubscribe. */
  constructor(private readonly watch: (webContentsId: number, onGone: () => void) => () => void) {}

  /** The view's capability, minted on first use; the same one for as long as the view lives. */
  capabilityFor(webContentsId: number): string {
    const existing = this.byView.get(webContentsId);
    if (existing) return existing.token;
    const token = crypto.randomBytes(16).toString("hex");
    this.viewByToken.set(token, webContentsId);
    const entry = { token, unwatch: () => {} };
    this.byView.set(webContentsId, entry);
    entry.unwatch = this.watch(webContentsId, () => this.revoke(webContentsId));
    return token;
  }

  viewFor(token: string): number | null {
    return this.viewByToken.get(token) ?? null;
  }

  revoke(webContentsId: number): void {
    const entry = this.byView.get(webContentsId);
    if (!entry) return;
    this.byView.delete(webContentsId);
    this.viewByToken.delete(entry.token);
    entry.unwatch();
  }

  dispose(): void {
    for (const webContentsId of [...this.byView.keys()]) this.revoke(webContentsId);
  }
}
