import type { Migration } from "../StoreMigrations.js";

/**
 * Canopy is on by default now that its reader ships inside the app (issue
 * #16415): a user still in `unset`, the old default, is turned on. `hidden` is
 * the user saying they don't want it, and stays.
 *
 * Self-contained on purpose: a migration is a snapshot of the shape it moves.
 */
export const migration043: Migration = {
  version: 43,
  description: "Turn Canopy on for users still in the old unset default (issue #16415)",
  up: (store) => {
    const mode = store.get("canopyMode") as unknown;
    if (mode !== "unset") return;
    store.set("canopyMode", "on");
    console.log("[Migration 043] Turned Canopy on");
  },
};
