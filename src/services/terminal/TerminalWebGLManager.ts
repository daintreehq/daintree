import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable } from "@xterm/xterm";
import type { ManagedTerminal } from "./types";

const WEBGL_DISABLED = import.meta.env.CANOPY_DISABLE_WEBGL === "1";

interface WebGLEntry {
  addon: WebglAddon;
  contextLossDisposable: IDisposable;
}

export class TerminalWebGLManager {
  // Chromium caps active WebGL contexts at 16 per renderer process.
  // Reserve 4 slots for potential non-terminal WebGL consumers in the
  // main renderer (browser/dev-preview panels are process-isolated via
  // <webview> partitions and have their own budgets).
  static readonly MAX_CONTEXTS = 12;

  private pool = new Map<string, WebGLEntry>();
  private lruOrder: string[] = [];

  ensureContext(id: string, managed: ManagedTerminal): void {
    if (WEBGL_DISABLED) return;
    if (!managed.isOpened) return;

    if (this.pool.has(id)) {
      this.moveLruToEnd(id);
      return;
    }

    if (this.pool.size >= TerminalWebGLManager.MAX_CONTEXTS) {
      const evictId = this.lruOrder[0];
      if (evictId) {
        this.doRelease(evictId);
      }
    }

    let addon: WebglAddon | null = null;
    let clDisposable: IDisposable | null = null;
    try {
      addon = new WebglAddon();
      const ownAddon = addon;
      clDisposable = addon.onContextLoss(() => {
        if (this.pool.get(id)?.addon === ownAddon) {
          this.releaseContext(id);
        }
      });
      managed.terminal.loadAddon(addon);
      this.pool.set(id, { addon, contextLossDisposable: clDisposable });
      this.lruOrder.push(id);
    } catch {
      try {
        clDisposable?.dispose();
      } catch {
        // ignore
      }
      try {
        addon?.dispose();
      } catch {
        // ignore
      }
    }
  }

  releaseContext(id: string): void {
    if (this.pool.has(id)) {
      this.doRelease(id);
    }
  }

  isActive(id: string): boolean {
    return this.pool.has(id);
  }

  onTerminalDestroyed(id: string): void {
    const entry = this.pool.get(id);
    if (entry) {
      try {
        entry.contextLossDisposable.dispose();
      } catch {
        // ignore
      }
      this.pool.delete(id);
      this.removeFromLru(id);
    }
  }

  dispose(): void {
    for (const id of [...this.pool.keys()]) {
      this.doRelease(id);
    }
  }

  private doRelease(id: string): void {
    const entry = this.pool.get(id);
    if (!entry) return;

    this.pool.delete(id);
    this.removeFromLru(id);

    try {
      entry.contextLossDisposable.dispose();
    } catch {
      // ignore
    }
    try {
      entry.addon.dispose();
    } catch {
      // ignore
    }
  }

  private moveLruToEnd(id: string): void {
    const idx = this.lruOrder.indexOf(id);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
    this.lruOrder.push(id);
  }

  private removeFromLru(id: string): void {
    const idx = this.lruOrder.indexOf(id);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
  }
}
