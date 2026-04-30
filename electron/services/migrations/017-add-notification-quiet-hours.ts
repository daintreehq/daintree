import type { Migration } from "../StoreMigrations.js";

export const migration017: Migration = {
  version: 17,
  description: "Add quiet hours schedule fields to notificationSettings",
  up: (store) => {
    const settings = store.get("notificationSettings") as Record<string, unknown> | undefined;
    if (!settings || typeof settings !== "object") {
      console.log("[Migration 017] No notificationSettings found, skipping");
      return;
    }

    const patch: Record<string, unknown> = {};
    if (settings.quietHoursEnabled === undefined) patch.quietHoursEnabled = false;
    if (typeof settings.quietHoursStartMin !== "number") patch.quietHoursStartMin = 22 * 60;
    if (typeof settings.quietHoursEndMin !== "number") patch.quietHoursEndMin = 8 * 60;
    if (!Array.isArray(settings.quietHoursWeekdays)) patch.quietHoursWeekdays = [];

    if (Object.keys(patch).length === 0) {
      console.log("[Migration 017] Quiet hours fields already present, skipping");
      return;
    }

    console.log("[Migration 017] Backfilling quiet hours schedule fields");
    store.set("notificationSettings", { ...settings, ...patch });
  },
};
