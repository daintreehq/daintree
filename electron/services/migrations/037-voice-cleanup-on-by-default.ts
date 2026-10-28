import type { Migration } from "../StoreMigrations.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const migration037: Migration = {
  version: 37,
  description: "Turn AI cleanup of dictation on for existing installs (#14615)",
  up: (store) => {
    const raw = store.get("voiceInput");

    if (!isPlainObject(raw)) {
      console.log("[Migration 037] No voiceInput settings found, skipping");
      return;
    }

    // The old default was off and electron-store persisted it, so a stored
    // `false` can't be told apart from a deliberate choice. Everyone moves to
    // the new default once; turning it back off is one switch, and this never
    // runs again to undo that.
    if (raw.correctionEnabled === true) {
      console.log("[Migration 037] Cleanup already on, skipping");
      return;
    }

    console.log("[Migration 037] Turning AI cleanup of dictation on");
    store.set("voiceInput", { ...raw, correctionEnabled: true });
  },
};
