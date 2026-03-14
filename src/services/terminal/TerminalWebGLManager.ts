import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable } from "@xterm/xterm";
import type { ManagedTerminal } from "./types";

const WEBGL_DISABLED = import.meta.env.CANOPY_DISABLE_WEBGL === "1";

export class TerminalWebGLManager {
  private currentId: string | null = null;
  private currentAddon: WebglAddon | null = null;
  private contextLossDisposable: IDisposable | null = null;

  attachToFocused(id: string, managed: ManagedTerminal): void {
    if (WEBGL_DISABLED) return;
    if (this.currentId === id) return;
    if (!managed.isOpened) return;

    this.detachCurrent();

    let addon: WebglAddon | null = null;
    let clDisposable: IDisposable | null = null;
    try {
      addon = new WebglAddon();
      clDisposable = addon.onContextLoss(() => {
        if (this.currentId === id && this.currentAddon === addon) {
          this.detachCurrent();
        }
      });
      managed.terminal.loadAddon(addon);
      this.currentId = id;
      this.currentAddon = addon;
      this.contextLossDisposable = clDisposable;
    } catch {
      // WebGL unavailable (CI, older GPU, context limit) — stay on DOM renderer.
      // Clean up partially-constructed addon to prevent leaks.
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

  detachCurrent(): void {
    if (this.contextLossDisposable) {
      try {
        this.contextLossDisposable.dispose();
      } catch {
        // ignore
      }
      this.contextLossDisposable = null;
    }
    if (this.currentAddon) {
      try {
        this.currentAddon.dispose();
      } catch {
        // ignore
      }
      this.currentAddon = null;
    }
    this.currentId = null;
  }

  isCurrent(id: string): boolean {
    return this.currentId === id;
  }

  detachIfCurrent(id: string): void {
    if (this.currentId === id) {
      this.detachCurrent();
    }
  }

  onTerminalDestroyed(id: string): void {
    if (this.currentId === id) {
      // Null out references without disposing — the terminal itself is being
      // disposed and will clean up the addon.
      this.contextLossDisposable = null;
      this.currentAddon = null;
      this.currentId = null;
    }
  }

  dispose(): void {
    this.detachCurrent();
  }
}
