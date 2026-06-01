import { create } from "zustand";

/**
 * Visibility state for the graduated plugin manager view (#9558). Mirrors
 * `themeBrowserStore` — the manager is now a first-class full-screen overlay
 * mounted in `AppLayout` (via portal), not a modal dialog. The `app.pluginManager`
 * action fires a `daintree:open-plugin-manager` CustomEvent that
 * `useAppEventListeners` translates into `open()`, keeping action-definition
 * modules free of renderer-store imports.
 */
interface PluginManagerState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const usePluginManagerStore = create<PluginManagerState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
