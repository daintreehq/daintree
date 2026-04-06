import type { Migration } from "../StoreMigrations.js";

export const migration008: Migration = {
  version: 8,
  description: "Split soundFile into per-event notification sound fields",
  up: (store) => {
    const settings = store.get("notificationSettings") as
      | { soundFile?: string; [key: string]: unknown }
      | undefined;

    if (!settings) {
      console.log("[Migration 008] No notificationSettings found, skipping");
      return;
    }

    const oldSoundFile = typeof settings.soundFile === "string" ? settings.soundFile : "chime.wav";

    console.log(`[Migration 008] Migrating soundFile "${oldSoundFile}" to per-event sound fields`);

    const { soundFile: _, ...rest } = settings;
    store.set("notificationSettings", {
      ...rest,
      completedSoundFile: oldSoundFile,
      waitingSoundFile: "waiting.wav",
      escalationSoundFile: "ping.wav",
    });
  },
};
