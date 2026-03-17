import type { Migration } from "../StoreMigrations.js";

export const migration007: Migration = {
  version: 7,
  description: "Reduce default terminal scrollback from 2500 to 1000",
  up: (store) => {
    const config = store.get("terminalConfig") as
      | { scrollbackLines?: number; [key: string]: unknown }
      | undefined;

    if (!config) {
      console.log("[Migration 007] No terminalConfig found, skipping");
      return;
    }

    if (config.scrollbackLines === 2500) {
      console.log("[Migration 007] Migrating scrollbackLines from 2500 to 1000");
      store.set("terminalConfig", { ...config, scrollbackLines: 1000 });
    } else {
      console.log(
        `[Migration 007] scrollbackLines is ${config.scrollbackLines ?? "(unset)"}, skipping`
      );
    }
  },
};
