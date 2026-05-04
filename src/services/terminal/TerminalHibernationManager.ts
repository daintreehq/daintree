import { Terminal } from "@xterm/xterm";
import type { ManagedTerminal } from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { logDebug, logError } from "@/utils/logger";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";

export interface HibernationManagerDeps extends TerminalListenerInstallDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  destroyRestoreState: (id: string) => void;
  resetBufferedOutput: (id: string) => void;
  releaseWebGL: (id: string) => void;
  clearResizeJob: (managed: ManagedTerminal) => void;
  clearSettledTimer: (id: string) => void;
  applyDeferredResize: (id: string) => void;
  openLink: (url: string, id: string, event?: MouseEvent) => void;
  getCwdProvider: (id: string) => (() => string) | undefined;
}

export class TerminalHibernationManager {
  private deps: HibernationManagerDeps;

  constructor(deps: HibernationManagerDeps) {
    this.deps = deps;
  }

  hibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (
      !managed ||
      managed.isHibernated ||
      (managed.runtimeAgentId &&
        managed.canonicalAgentState !== "completed" &&
        managed.canonicalAgentState !== "exited")
    )
      return;

    logDebug(`[TIS.hibernate] Hibernating terminal ${id}`);

    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }

    this.deps.destroyRestoreState(id);
    this.deps.resetBufferedOutput(id);

    // Release WebGL context first to avoid context leaks
    this.deps.releaseWebGL(id);

    // Dispose tier-managed addons
    try {
      managed.imageAddon?.dispose();
    } catch {
      /* ignore */
    }
    managed.imageAddon = null;
    try {
      managed.fileLinksDisposable?.dispose();
    } catch {
      /* ignore */
    }
    managed.fileLinksDisposable = null;
    try {
      managed.webLinksAddon?.dispose();
    } catch {
      /* ignore */
    }
    managed.webLinksAddon = null;

    // Dispose terminal-bound listeners (keep IPC listeners at the beginning)
    const terminalBoundListeners = managed.listeners.splice(managed.ipcListenerCount);
    for (const unsub of terminalBoundListeners) {
      try {
        unsub();
      } catch {
        /* ignore — terminal already disposing */
      }
    }

    // Dispose parser handler
    try {
      managed.parserHandler?.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }
    managed.parserHandler = undefined;

    // Dispose last activity marker
    try {
      managed.lastActivityMarker?.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }
    managed.lastActivityMarker = undefined;

    // Dispose terminal instance — this removes xterm's injected DOM elements
    // from the hostElement but leaves the hostElement itself in the DOM
    // so XtermAdapter's container ref stays valid for reattachment
    try {
      managed.terminal.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }

    managed.isHibernated = true;
    managed.isOpened = false;
    managed.keyHandlerInstalled = false;

    // Clear resize state
    this.deps.clearResizeJob(managed);
    this.deps.clearSettledTimer(id);
  }

  unhibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || !managed.isHibernated) return;

    logDebug(`[TIS.unhibernate] Restoring terminal ${id}`);

    // Create fresh Terminal with same options
    const terminal = new Terminal(managed.terminal.options);
    managed.terminal = terminal;

    // Create fresh addons
    const openLink = (url: string, event?: MouseEvent) => {
      this.deps.openLink(url, id, event);
    };
    const addons = setupTerminalAddons(
      terminal,
      () => (this.deps.getCwdProvider(id) ?? (() => ""))(),
      (event, uri) => openLink(uri, event)
    );
    managed.fitAddon = addons.fitAddon;
    managed.serializeAddon = addons.serializeAddon;
    managed.searchAddon = addons.searchAddon;
    managed.imageAddon = addons.imageAddon;
    managed.fileLinksDisposable = addons.fileLinksDisposable;
    managed.webLinksAddon = addons.webLinksAddon;

    // Reuse existing hostElement — clear old xterm DOM nodes to prevent ghosting
    const hostElement = managed.hostElement;
    hostElement.replaceChildren();

    // Re-create parser handler
    managed.parserHandler = new TerminalParserHandler(managed, () => {
      this.deps.applyDeferredResize(id);
    });

    // Re-register terminal-bound listeners via the canonical installer so the
    // wake path stays in lockstep with `getOrCreate()`. IPC listeners
    // captured before `ipcListenerCount` survive in `managed.listeners`.
    installTerminalBoundListeners(terminal, managed, id, this.deps);

    // Reset restore state
    managed.writeChain = Promise.resolve();
    managed.restoreGeneration += 1;
    managed.isSerializedRestoreInProgress = false;
    managed.deferredOutput = [];
    // Clear the reflow throttle so post-wake writes trigger an immediate
    // IO re-evaluation.
    managed.lastReflowAt = 0;

    // Re-bind the fresh Terminal to its DOM host. Without this, the
    // terminal exists in memory with a working buffer but no rendered
    // output — a zombie. Only safe when the host has measurable
    // dimensions (xterm.js measures character cell size during open()).
    // If the host is offscreen/zero-sized, leave isOpened=false so
    // TerminalInstanceService.attach() will open it on next mount.
    if (hostElement.clientWidth > 0 && hostElement.clientHeight > 0) {
      try {
        terminal.open(hostElement);
        managed.isOpened = true;
      } catch (err) {
        logError(`[TIS.unhibernate] terminal.open failed for ${id}`, err);
      }
    }

    managed.isHibernated = false;
    managed.isDetached = managed.isDetached ?? false;
    if (managed.isOpened) {
      managed.isDetached = false;
    }
  }
}
