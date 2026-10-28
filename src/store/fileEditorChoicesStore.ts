import { create } from "zustand";
import type {
  FileEditorChoice,
  FileEditorChoiceKey,
  FileEditorChoices,
} from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/**
 * This project view's "Edit with…" answers (#13809), mirrored from main, which
 * keeps them per project in Daintree's own settings. One project per view, so
 * the copy here is that project's and never another's.
 *
 * `loaded` stays false until the first pull lands: an unknown answer must not
 * mount a plugin editor the user may have already turned away from.
 */
interface FileEditorChoicesState {
  choices: FileEditorChoices;
  loaded: boolean;
  init: () => void;
  /** Remember (or, with `null`, forget) one answer. Applied here at once; main is the record. */
  setChoice: (key: FileEditorChoiceKey, choice: FileEditorChoice | null) => Promise<void>;
}

let initialized = false;

export const useFileEditorChoicesStore = create<FileEditorChoicesState>((set, get) => ({
  choices: {},
  loaded: false,
  init: () => {
    if (initialized) return;
    const plugin = typeof window === "undefined" ? undefined : window.electron?.plugin;
    if (typeof plugin?.getFileEditorChoices !== "function") {
      // No bridge (tests, a partial stub): nothing is remembered, so nothing to wait for.
      set({ loaded: true });
      return;
    }
    initialized = true;
    void plugin
      .getFileEditorChoices()
      .then((choices) => set({ choices, loaded: true }))
      .catch((err: unknown) => {
        logWarn("[FileEditorChoices] Failed to load file editor choices", { error: err });
        // Fall back to the defaults rather than hold every plugin editor back.
        set({ loaded: true });
      });
  },
  setChoice: async (key, choice) => {
    const previous = get().choices;
    const next: Record<string, FileEditorChoice> = { ...previous };
    if (choice === null) delete next[key];
    else next[key] = choice;
    set({ choices: next });
    const plugin = window.electron?.plugin;
    if (typeof plugin?.setFileEditorChoice !== "function") return;
    try {
      set({ choices: await plugin.setFileEditorChoice(key, choice) });
    } catch (err) {
      // The pick still applies for this session; it just won't be remembered.
      logWarn("[FileEditorChoices] Failed to remember file editor choice", { error: err });
    }
  },
}));

/** Test-only: reset the module-level init guard and the mirror. */
export function _resetFileEditorChoicesStoreForTest(): void {
  initialized = false;
  useFileEditorChoicesStore.setState({ choices: {}, loaded: false });
}
