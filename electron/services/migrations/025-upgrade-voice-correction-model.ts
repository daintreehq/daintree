import type { Migration } from "../StoreMigrations.js";

// Hard-coded target — a migration is an immutable snapshot. Do NOT import the
// live VOICE_DICTATION_AI_MODEL constant: if the active voice model moves again,
// this migration must still upgrade v24 stores to the value that was current
// when schema v25 shipped, independent of whatever the constant becomes later.
const TARGET_CORRECTION_MODEL = "gpt-5.6-luna";

export const migration025: Migration = {
  version: 25,
  description: "Migrate voice correction model to gpt-5.6-luna (retires gpt-5-mini/gpt-5-nano)",
  up: (store) => {
    const voiceInput = store.get("voiceInput") as
      { correctionModel?: string; [key: string]: unknown } | undefined;

    if (!voiceInput) {
      console.log("[Migration 025] No voiceInput settings found, skipping");
      return;
    }

    // gpt-5.6-luna replaced both the gpt-5-mini and gpt-5-nano tiers, so the
    // union is single-valued now — force every non-current value (missing,
    // nano, mini, or malformed) to the target while preserving sibling fields.
    if (voiceInput.correctionModel === TARGET_CORRECTION_MODEL) {
      console.log(`[Migration 025] correctionModel already "${TARGET_CORRECTION_MODEL}", skipping`);
      return;
    }

    console.log(
      `[Migration 025] Upgrading correctionModel from "${voiceInput.correctionModel ?? "(unset)"}" to "${TARGET_CORRECTION_MODEL}"`
    );
    store.set("voiceInput", { ...voiceInput, correctionModel: TARGET_CORRECTION_MODEL });
  },
};
