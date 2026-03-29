import type { Migration } from "../StoreMigrations.js";

export const migration010: Migration = {
  version: 10,
  description: "Add working pulse notification settings",
  up: (store) => {
    const settings = store.get("notificationSettings") as Record<string, unknown> | undefined;

    if (!settings) {
      console.log("[Migration 010] No notificationSettings found, skipping");
      return;
    }

    if (settings.workingPulseEnabled !== undefined) {
      console.log("[Migration 010] workingPulseEnabled already exists, skipping");
      return;
    }

    console.log("[Migration 010] Adding workingPulseEnabled and workingPulseSoundFile");
    store.set("notificationSettings", {
      ...settings,
      workingPulseEnabled: false,
      workingPulseSoundFile: "pulse.wav",
    });
  },
};
