import type { Migration } from "../StoreMigrations.js";

/**
 * The Fleet Deck overlay was replaced by the main-grid broadcast surface in
 * #5557. Its persisted `appState.fleetDeckOpen` flag (plus the latent
 * `fleetDeckAlwaysPreview` / `fleetDeckQuorumThreshold` keys that were in the
 * IPC surface but never validated through to disk) is now orphaned. Strip the
 * keys so existing stores don't carry dead state forward.
 */
export const migration019: Migration = {
  version: 19,
  description: "Remove orphaned fleet deck keys after Fleet Deck removal",
  up: (store) => {
    const appState = store.get("appState");
    if (!appState || typeof appState !== "object") return;

    const next = { ...appState } as Record<string, unknown>;
    let changed = false;
    for (const key of ["fleetDeckOpen", "fleetDeckAlwaysPreview", "fleetDeckQuorumThreshold"]) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    }

    if (changed) {
      store.set("appState", next as typeof appState);
    }
  },
};
