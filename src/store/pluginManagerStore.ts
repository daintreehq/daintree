import { create } from "zustand";

/**
 * Where a plugin's settings live. Each plugin has one home per scope and a deep
 * link always lands in it: the plugin manager for an installed plugin's own
 * settings, Project settings → Plugins for a project plugin (or an installed
 * plugin's project-scoped key).
 */
export type PluginSettingsHome = "manager" | "project";

/**
 * A pending "show this plugin's settings" request from `plugin.openSettings`.
 * The home it names consumes it; `nonce` makes a repeat request for the same
 * plugin and key land again rather than read as already handled.
 */
export interface PluginSettingsRequest {
  /** The plugin's instance key — what every settings surface keys on. */
  pluginId: string;
  /** A declared setting to scroll to and highlight, when the request named one. */
  key?: string;
  home: PluginSettingsHome;
  nonce: number;
}

/**
 * Visibility state for the graduated plugin manager view (#9558). Mirrors
 * `themeBrowserStore` — the manager is now a first-class full-screen overlay
 * mounted in `AppLayout` (via portal), not a modal dialog. The `app.pluginManager`
 * action fires a `daintree:open-plugin-manager` CustomEvent that
 * `useAppEventListeners` translates into `open()`, keeping action-definition
 * modules free of renderer-store imports.
 *
 * Also carries the one pending plugin-settings deep link, for both homes, so
 * the manager and Project settings → Plugins read the same request.
 */
interface PluginManagerState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  settingsRequest: PluginSettingsRequest | null;
  /** Record a settings deep link; a manager-home request also opens the manager. */
  requestSettings: (request: Omit<PluginSettingsRequest, "nonce">) => void;
  /** Drop the request once its home has applied it. A newer request is kept. */
  consumeSettingsRequest: (nonce: number) => void;
  /**
   * What had focus when the manager opened — a panel, a menu's trigger, a
   * settings control. The manager is a region rather than a modal, so nothing
   * returns focus for it on close; the view hands it back from here.
   */
  returnFocusTarget: HTMLElement | null;
}

let nextSettingsNonce = 1;

/** The element to return to when the manager closes, captured as it opens. */
function captureReturnFocus(wasOpen: boolean, current: HTMLElement | null): HTMLElement | null {
  if (wasOpen || typeof document === "undefined") return current;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export const usePluginManagerStore = create<PluginManagerState>()((set, get) => ({
  isOpen: false,
  open: () =>
    set({
      isOpen: true,
      returnFocusTarget: captureReturnFocus(get().isOpen, get().returnFocusTarget),
    }),
  close: () => set({ isOpen: false }),
  settingsRequest: null,
  returnFocusTarget: null,
  requestSettings: (request) => {
    const settingsRequest = { ...request, nonce: nextSettingsNonce++ };
    // The manager is a full-screen overlay: a project-home request has to take
    // it down, or the settings dialog would open underneath it.
    set(
      request.home === "manager"
        ? {
            settingsRequest,
            isOpen: true,
            returnFocusTarget: captureReturnFocus(get().isOpen, get().returnFocusTarget),
          }
        : { settingsRequest, isOpen: false }
    );
  },
  consumeSettingsRequest: (nonce) =>
    set((state) => (state.settingsRequest?.nonce === nonce ? { settingsRequest: null } : state)),
}));
