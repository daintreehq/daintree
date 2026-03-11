import type { Migration } from "../StoreMigrations.js";

export const migration004: Migration = {
  version: 4,
  description: "Upgrade default voice correction model from gpt-5-nano to gpt-5-mini",
  up: (store) => {
    const voiceInput = store.get("voiceInput") as
      | { correctionModel?: string; [key: string]: unknown }
      | undefined;

    if (!voiceInput) {
      console.log("[Migration 004] No voiceInput settings found, skipping");
      return;
    }

    if (!voiceInput.correctionModel || voiceInput.correctionModel === "gpt-5-nano") {
      console.log(
        `[Migration 004] Upgrading correctionModel from "${voiceInput.correctionModel ?? "(unset)"}" to "gpt-5-mini"`
      );
      store.set("voiceInput", { ...voiceInput, correctionModel: "gpt-5-mini" });
    } else {
      console.log(
        `[Migration 004] correctionModel already "${voiceInput.correctionModel}", skipping`
      );
    }
  },
};
