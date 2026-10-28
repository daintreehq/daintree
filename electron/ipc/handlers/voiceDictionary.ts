// eager-import-allow: reads and writes the voice dictionary via store.get/store.set synchronously in the IPC handler
import { z } from "zod";
import { store } from "../../store.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { getVoiceSettings } from "./voiceInput.js";
import { VOICE_DICTIONARY_METHOD_CHANNELS } from "./voiceDictionary.preload.js";
import {
  changeProjectVoiceDictionary,
  readProjectVoiceDictionary,
} from "../../services/projectVoiceDictionary.js";
import type {
  DismissedSuggestion,
  VoiceDictionaryEntry,
  VoiceDictionaryState,
  VoiceInputSettings,
} from "../../../shared/types/ipc/api.js";
import {
  DICTIONARY_CONTROL_CHARACTERS,
  MAX_DICTIONARY_HEARD_AS,
  acceptSuggestion,
  addDictionaryEntry,
  dismissSuggestion,
  mergeSuggestions,
  removeDictionaryEntry,
  updateDictionaryEntry,
} from "../../../shared/utils/voiceDictionary.js";

// Bounds on the raw payload only; the dictionary model trims and applies the
// real term length cap, so a value over it is refused with a reason. A term
// that names an existing entry is unbounded: one kept from the old word list
// can be longer than any new term, and must still be removable.
const RAW_TEXT_MAX = 1_000;
const LIST_MAX = 200;
const text = z.string().max(RAW_TEXT_MAX);
const existing = z.string();
const heardAs = z.array(text).max(MAX_DICTIONARY_HEARD_AS);

const addSchema = z.object({
  term: text,
  heardAs: heardAs.optional(),
  // Source and time ride along only so an undone removal restores the entry as it was.
  source: z.enum(["manual", "learned", "imported"]).optional(),
  addedAt: z.number().finite().nonnegative().optional(),
});
const removeSchema = z.object({ term: existing });
const updateSchema = z.object({
  term: existing,
  changes: z.object({ term: text.optional(), heardAs: heardAs.optional() }),
});
const suggestionSchema = z.object({ word: existing, utterance: text.optional() });
const projectId = z.string().min(1).max(RAW_TEXT_MAX);
// A project's terms can be committed to the repo, where a read leaves out any
// phrase holding a line break or control character, so one can't be added.
const projectText = text.refine(
  (value) => !DICTIONARY_CONTROL_CHARACTERS.test(value.trim()),
  "A dictionary phrase can't hold a line break or control character"
);
const projectHeardAs = z.array(projectText).max(LIST_MAX);
const projectSchema = z.object({ projectId });
const projectAddSchema = addSchema.extend({
  projectId,
  term: projectText,
  heardAs: projectHeardAs.optional(),
});
const projectRemoveSchema = removeSchema.extend({ projectId });
const projectUpdateSchema = updateSchema.extend({
  projectId,
  changes: z.object({ term: projectText.optional(), heardAs: projectHeardAs.optional() }),
});
const recordSchema = z.object({
  candidates: z.array(z.object({ word: text, original: text })).max(LIST_MAX),
});

/**
 * One read-modify-write of the stored dictionary. Main is the only writer and
 * runs this synchronously, so no other operation can land between the read
 * and the write: two changes made at once both survive. Both lists go back in
 * one write, so an accept can't land half done, and nothing is written when
 * nothing changed.
 */
function change(
  apply: (
    state: VoiceDictionaryState,
    settings: VoiceInputSettings
  ) => VoiceDictionaryState & { dismissedSuggestions?: DismissedSuggestion[] }
): VoiceDictionaryState {
  // getVoiceSettings has already repaired and persisted what it read.
  const settings = getVoiceSettings();
  const current: VoiceDictionaryState = {
    dictionary: settings.dictionary,
    suggestedDictionary: settings.suggestedDictionary,
  };
  const result = apply(current, settings);
  const next: VoiceDictionaryState = {
    dictionary: result.dictionary,
    suggestedDictionary: result.suggestedDictionary,
  };
  const dismissed = result.dismissedSuggestions ?? settings.dismissedSuggestions;
  if (
    next.dictionary !== current.dictionary ||
    next.suggestedDictionary !== current.suggestedDictionary ||
    dismissed !== settings.dismissedSuggestions
  ) {
    // The stored object, not `settings`: that one carries env-var key overrides.
    store.set("voiceInput", {
      ...store.get("voiceInput"),
      dictionary: next.dictionary,
      suggestedDictionary: next.suggestedDictionary,
      dismissedSuggestions: dismissed,
    });
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
      async ({ word, utterance }): Promise<VoiceDictionaryState> =>
        change((state) => acceptSuggestion(state, word, Date.now(), utterance))
    ),
    dismissSuggestion: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.dismissSuggestion,
      suggestionSchema,
      async ({ word, utterance }): Promise<VoiceDictionaryState> =>
        change((state, settings) => ({
          ...state,
          ...dismissSuggestion(
            state.suggestedDictionary,
            settings.dismissedSuggestions,
            word,
            utterance
          ),
        }))
    ),
    // The learner reports what it saw and main merges it into the queue it
    // holds, so the learner's copy can't overwrite an accept or dismiss made
    // meanwhile. A dismissed word and utterance pair is skipped.
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
            Date.now(),
            settings.dismissedSuggestions
          );
          return next ? { ...state, suggestedDictionary: next } : state;
        })
    ),
    // A project's vocabulary lives with the project, and is shared through the
    // repo when the project keeps its settings there.
    getProject: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.getProject,
      projectSchema,
      async ({ projectId }): Promise<VoiceDictionaryEntry[]> =>
        readProjectVoiceDictionary(projectId)
    ),
    addToProject: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.addToProject,
      projectAddSchema,
      async ({ projectId, ...input }): Promise<VoiceDictionaryEntry[]> =>
        changeProjectVoiceDictionary(projectId, (entries) =>
          addDictionaryEntry(entries, input, Date.now())
        )
    ),
    removeFromProject: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.removeFromProject,
      projectRemoveSchema,
      async ({ projectId, term }): Promise<VoiceDictionaryEntry[]> =>
        changeProjectVoiceDictionary(projectId, (entries) => removeDictionaryEntry(entries, term))
    ),
    updateInProject: opValidated(
      VOICE_DICTIONARY_METHOD_CHANNELS.updateInProject,
      projectUpdateSchema,
      async ({ projectId, term, changes }): Promise<VoiceDictionaryEntry[]> =>
        changeProjectVoiceDictionary(projectId, (entries) =>
          updateDictionaryEntry(entries, term, changes)
        )
    ),
  },
});

export function registerVoiceDictionaryHandlers(): () => void {
  return voiceDictionaryNamespace.register();
}
