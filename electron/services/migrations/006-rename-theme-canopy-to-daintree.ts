import type { Migration } from "../StoreMigrations.js";

const OLD_IDS = new Set(["canopy", "canopy-slate"]);

export const migration006: Migration = {
  version: 6,
  description: "Rename theme id canopy/canopy-slate to daintree",
  up: (store) => {
    const appTheme = store.get("appTheme") as
      | { colorSchemeId?: string; [key: string]: unknown }
      | undefined;

    if (!appTheme) {
      console.log("[Migration 006] No appTheme settings found, skipping");
      return;
    }

    if (typeof appTheme.colorSchemeId === "string" && OLD_IDS.has(appTheme.colorSchemeId)) {
      console.log(
        `[Migration 006] Renaming colorSchemeId from "${appTheme.colorSchemeId}" to "daintree"`
      );
      store.set("appTheme", { ...appTheme, colorSchemeId: "daintree" });
    } else {
      console.log(
        `[Migration 006] colorSchemeId is "${appTheme.colorSchemeId ?? "(unset)"}", skipping`
      );
    }
  },
};
