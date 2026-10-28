import type { Migration } from "../StoreMigrations.js";

/**
 * Move stored "toggle" dictation onto the new tap-or-hold default (issue
 * #14626). electron-store wrote "toggle" to every install as the old default,
 * so a chosen toggle can't be told apart from an untouched one. A tap behaves
 * exactly as toggle did; only a hold that heard speech stops on release.
 * Push-to-talk and anything else are left alone, and Toggle stays selectable.
 */
export const migration038: Migration = {
  version: 38,
  description: "Move toggle dictation onto the tap-or-hold default (issue #14626)",
  up: (store) => {
    const voiceInput = store.get("voiceInput") as Record<string, unknown> | undefined;
    if (!voiceInput || typeof voiceInput !== "object") return;
    if (voiceInput.recordingMode !== "toggle") return;
    store.set("voiceInput", { ...voiceInput, recordingMode: "tap-or-hold" });
  },
};
