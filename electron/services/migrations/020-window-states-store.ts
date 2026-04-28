import type { Migration } from "../StoreMigrations.js";
import { windowStatesStore } from "../../store.js";

export const migration020: Migration = {
  version: 20,
  description: "Move window state to dedicated window-states store",
  up: (store) => {
    const windowStates = store.get("windowStates") ?? {};
    const windowState = store.get("windowState");

    const existing = windowStatesStore.get("windowStates") ?? {};
    const merged: Record<string, unknown> = { ...windowStates, ...existing };

    // Only seed __legacy__ from legacy windowState when the windowStates map has
    // no per-project entries (migration 009 never ran). If per-project entries
    // already exist, migration 009 already handled the legacy key.
    const hasProjectEntries = Object.keys(merged).some((k) => k !== "__legacy__");

    if (
      !hasProjectEntries &&
      windowState &&
      typeof windowState === "object" &&
      (windowState as Record<string, unknown>).width !== undefined &&
      !merged.__legacy__
    ) {
      merged.__legacy__ = {
        x: (windowState as Record<string, unknown>).x,
        y: (windowState as Record<string, unknown>).y,
        width: (windowState as Record<string, unknown>).width ?? 1200,
        height: (windowState as Record<string, unknown>).height ?? 800,
        isMaximized: (windowState as Record<string, unknown>).isMaximized ?? false,
        isFullScreen: (windowState as Record<string, unknown>).isFullScreen ?? false,
      };
    }

    windowStatesStore.set("windowStates", merged);

    // Clean up legacy keys from main store (use delete, not set(undefined) — electron-store v11 throws on undefined values, per #2727)
    store.delete("windowStates");
    store.delete("windowState");
  },
};
