import type { Migration } from "../StoreMigrations.js";

// Hard-coded target — a migration is an immutable snapshot. Do NOT import the
// live OPENAI_TRANSCRIPTION_MODEL constant: if the active transcription model
// moves again, this migration must still upgrade v26 stores to the value that
// was current when schema v27 shipped, independent of whatever the constant
// becomes later.
const TARGET_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

export const migration027: Migration = {
  version: 27,
  description:
    "Migrate voice transcription model to gpt-live-transcribe (retires gpt-realtime-whisper)",
  up: (store) => {
    const voiceInput = store.get("voiceInput") as
      { transcriptionModel?: string; [key: string]: unknown } | undefined;

    if (!voiceInput) {
      console.log("[Migration 027] No voiceInput settings found, skipping");
      return;
    }

    // gpt-live-transcribe replaced gpt-realtime-whisper, so the union is
    // single-valued — force every non-current value (missing, the retired
    // whisper model, a legacy Deepgram model string, or malformed) to the
    // target while preserving sibling fields. `transcriptionProvider`, not the
    // model, is what selects the backend, so a Deepgram user's provider choice
    // rides through untouched.
    if (voiceInput.transcriptionModel === TARGET_TRANSCRIPTION_MODEL) {
      console.log(
        `[Migration 027] transcriptionModel already "${TARGET_TRANSCRIPTION_MODEL}", skipping`
      );
      return;
    }

    console.log(
      `[Migration 027] Upgrading transcriptionModel from "${voiceInput.transcriptionModel ?? "(unset)"}" to "${TARGET_TRANSCRIPTION_MODEL}"`
    );
    store.set("voiceInput", { ...voiceInput, transcriptionModel: TARGET_TRANSCRIPTION_MODEL });
  },
};
