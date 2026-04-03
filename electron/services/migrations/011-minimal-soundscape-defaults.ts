import type { Migration } from "../StoreMigrations.js";

export const migration011: Migration = {
  version: 11,
  description: "Tone down soundscape to minimal defaults (waiting only)",
  up: (store) => {
    const settings = store.get("notificationSettings") as Record<string, unknown> | undefined;

    if (!settings) {
      console.log("[Migration 011] No notificationSettings found, skipping");
      return;
    }

    const changes: Record<string, unknown> = {};

    if (settings.waitingEnabled === false) {
      changes.waitingEnabled = true;
    }
    if (settings.waitingEscalationEnabled === true) {
      changes.waitingEscalationEnabled = false;
    }
    if (settings.uiFeedbackSoundEnabled === true) {
      changes.uiFeedbackSoundEnabled = false;
    }

    if (Object.keys(changes).length > 0) {
      console.log("[Migration 011] Applying minimal soundscape defaults:", Object.keys(changes));
      store.set("notificationSettings", { ...settings, ...changes });
    } else {
      console.log("[Migration 011] Settings already match minimal defaults, skipping");
    }
  },
};
