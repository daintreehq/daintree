import type { Migration } from "../StoreMigrations.js";

export const migration009: Migration = {
  version: 9,
  description: "Seed windowStates map from legacy windowState",
  up: (store) => {
    const windowState = store.get("windowState") as
      | { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean }
      | undefined;

    if (
      !windowState ||
      (windowState.width === undefined && windowState.height === undefined) ||
      (windowState.width === 1200 && windowState.height === 800 && !windowState.x && !windowState.y)
    ) {
      console.log(
        "[Migration 009] No meaningful windowState found, initializing empty windowStates"
      );
      store.set("windowStates", {});
      return;
    }

    console.log("[Migration 009] Seeding windowStates from legacy windowState");
    store.set("windowStates", {
      __legacy__: {
        x: windowState.x,
        y: windowState.y,
        width: windowState.width ?? 1200,
        height: windowState.height ?? 800,
        isMaximized: windowState.isMaximized ?? false,
      },
    });
  },
};
