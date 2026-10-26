// eager-import-allow: reads and writes the voice dictionary via store.get/store.set synchronously in the IPC handler
import { z } from "zod";
import { store } from "../../store.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { getVoiceSettings } from "./voiceInput.js";
import { VOICE_DICTIONARY_METHOD_CHANNELS } from "./voiceDictionary.preload.js";
import type { VoiceDictionaryState, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import {
  acceptSuggestion,
  addDictionaryEntry,
  dismissSuggestion,
  mergeSuggestions,
  removeDictionaryEntry,
  sanitizeSuggestions,
  updateDictionaryEntry,
} from "../../../shared/utils/voiceDictionary.js";

// Bounds on the raw payload only; the dictionary model trims and applies the
// real term length cap, so a value over it is refused with a reason.
const RAW_TEXT_MAX = 1_000;
const LIST_MAX = 200;
const text = z.string().max(RAW_TEXT_MAX);
const heardAs = z.array(text).max(LIST_MAX);

const addSchema = z.object({
  term: text,
  heardAs: heardAs.optional(),
  source: z.enum(["manual", "imported"]).optional(),
});
const removeSchema = z.object({ term: text });
const updateSchema = z.object({
  term: text,
  changes: z.object({ term: text.optional(), heardAs: heardAs.optional() }),
});
const suggestionSchema = z.object({ word: text });
const recordSchema = z.object({
  candidates: z.array(z.object({ word: text, original: text })).max(LIST_MAX),
});

/**
 * One read-modify-write of the stored dictionary. Main is the only writer and
 * runs this synchronously, so no other operation can land between the read
 * and the write: two changes made at once both survive. Only what changed is
 * written back.
 */
function change(
  apply: (state: VoiceDictionaryState, settings: VoiceInputSettings) => VoiceDictionaryState
): VoiceDictionaryState {
  const settings = getVoiceSettings();
  const current: VoiceDictionaryState = {
    dictionary: settings.dictionary,
    suggestedDictionary: sanitizeSuggestions(settings.suggestedDictionary),
  };
  const next = apply(current, settings);
  if (next.dictionary !== current.dictionary) {
    store.set("voiceInput.dictionary", next.dictionary);
  }
  if (next.suggestedDictionary !== current.suggestedDictionary) {
    store.set("voiceInput.suggestedDictionary", next.suggestedDictionary);
  }
  return next;
}

export const voiceDictionaryNamespace = defineIpcNamespace({
  name: "voiceDictionary",
  ops: {
    add: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.add,
      addSchema,
      async (input): Promise<VoiceDictionaryState> =>
        change((state) => ({
          ...state,
          dictionary: addDictionaryEntry(state.dictionary, input, Date.now()),
        }))
    ),
    remove: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.remove,
      removeSchema,
      async ({ term }): Promise<VoiceDictionaryState> =>
        change((state) => ({ ...state, dictionary: removeDictionaryEntry(state.dictionary, term) }))
    ),
    update: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.update,
      updateSchema,
      async ({ term, changes }): Promise<VoiceDictionaryState> =>
        change((state) => ({
          ...state,
          dictionary: updateDictionaryEntry(state.dictionary, term, changes),
        }))
    ),
    acceptSuggestion: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.acceptSuggestion,
      suggestionSchema,
      async ({ word }): Promise<VoiceDictionaryState> =>
        change((state) => acceptSuggestion(state, word, Date.now()))
    ),
    dismissSuggestion: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.dismissSuggestion,
      suggestionSchema,
      async ({ word }): Promise<VoiceDictionaryState> =>
        change((state) => ({
          ...state,
          suggestedDictionary: dismissSuggestion(state.suggestedDictionary, word),
        }))
    ),
    // The learner reports what it saw; main decides what joins the queue, so a
    // suggestion accepted or dismissed meanwhile isn't brought back.
    recordSuggestions: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.recordSuggestions,
      recordSchema,
      async ({ candidates }): Promise<VoiceDictionaryState> =>
        change((state, settings) => {
          if (!settings.learnFromCorrections) return state;
          const next = mergeSuggestions(
            candidates,
            state.dictionary,
            state.suggestedDictionary,
            Date.now()
          );
          return next ? { ...state, suggestedDictionary: next } : state;
        })
    ),
  },
});

export function registerVoiceDictionaryHandlers(): () => void {
  return voiceDictionaryNamespace.register();
}
