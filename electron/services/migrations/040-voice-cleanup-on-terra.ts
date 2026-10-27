import type { Migration } from "../StoreMigrations.js";

// Hard-coded target: a migration is an immutable snapshot. Do NOT import the
// live VOICE_CLEANUP_AI_MODEL constant.
const TARGET_CORRECTION_MODEL = "gpt-6.1-terra";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const migration040: Migration = {
  version: 40,
  description: "Move dictation cleanup to gpt-6.1-terra for existing installs (#14793)",
  up: (store) => {
    const settings = store.get("voiceInput");

    if (!isPlainObject(settings)) {
      console.log("[Migration 040] No voiceInput settings found, skipping");
      return;
    }

    // A store without a model already reads the default.
    if (
      settings.correctionModel === undefined ||
      settings.correctionModel === TARGET_CORRECTION_MODEL
    ) {
      console.log("[Migration 040] No other correctionModel stored, skipping");
      return;
    }

    // Until now the model was forced on every read, so a stored gpt-6-luna is
    // no choice to keep. Everyone moves to the new default once; picking Luna
    // again is one click, and this never runs again to undo it.
    console.log(
      `[Migration 040] Moving correctionModel from "${String(settings.correctionModel)}" to "${TARGET_CORRECTION_MODEL}"`
    );
    store.set("voiceInput", { ...settings, correctionModel: TARGET_CORRECTION_MODEL });
  },
};
