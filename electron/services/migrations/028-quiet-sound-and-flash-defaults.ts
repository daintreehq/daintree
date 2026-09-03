import type { Migration } from "../StoreMigrations.js";

export const migration028: Migration = {
  version: 28,
  description: "Default sound and the all-clear flash off for existing installs (#12185)",
  up: (store) => {
    const settings = store.get("notificationSettings") as Record<string, unknown> | undefined;

    if (!settings) {
      console.log("[Migration 028] No notificationSettings found, skipping");
      return;
    }

    const changes: Record<string, unknown> = {};

    // soundEnabled was the last non-quiet default left in the soundscape
    // (#12185) — force it off like migration011 did for the others,
    // regardless of whether a persisted `true` is a deliberate choice or
    // just the old default. There is no way to tell the two apart, and
    // re-enabling costs one click in Settings.
    if (settings.soundEnabled !== false) {
      changes.soundEnabled = false;
    }

    // flashEnabled is a brand-new field. electron-store's defaults merge is
    // shallow, so every existing install is missing it from its persisted
    // notificationSettings blob and would otherwise read back `undefined`
    // forever — backfill it off, matching the sound default it is paired
    // with.
    if (typeof settings.flashEnabled !== "boolean") {
      changes.flashEnabled = false;
    }

    if (Object.keys(changes).length > 0) {
      console.log("[Migration 028] Applying quiet sound/flash defaults:", Object.keys(changes));
      store.set("notificationSettings", { ...settings, ...changes });
    } else {
      console.log("[Migration 028] Settings already quiet, skipping");
    }
  },
};
