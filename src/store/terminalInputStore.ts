import { create } from "zustand";
import type { EditorState } from "@codemirror/state";

const MAX_HISTORY_SIZE = 100;

// Controller registry — module-level Map (not Zustand state) to avoid triggering
// subscriber rerenders when HybridInputBar mounts/unmounts.
interface InputController {
  stash: () => void;
  pop: () => void;
}
const inputControllers = new Map<string, InputController>();

export function registerInputController(terminalId: string, controller: InputController): void {
  inputControllers.set(terminalId, controller);
}

export function unregisterInputController(terminalId: string): void {
  inputControllers.delete(terminalId);
}

export function triggerStashInput(terminalId: string): void {
  inputControllers.get(terminalId)?.stash();
}

export function triggerPopStash(terminalId: string): void {
  inputControllers.get(terminalId)?.pop();
}

/**
 * Creates a composite key for draft inputs that includes the project context.
 * This allows draft inputs to persist across project switches by associating
 * them with both the project and terminal ID.
 *
 * Key format: `{projectId}:{terminalId}` when projectId is provided,
 * otherwise just `{terminalId}` for backward compatibility.
 */
function makeDraftKey(terminalId: string, projectId?: string): string {
  return projectId ? `${projectId}:${terminalId}` : terminalId;
}

function deleteTerminalKeys<V>(map: Map<string, V>, terminalId: string): Map<string, V> {
  const suffix = `:${terminalId}`;
  let changed = false;
  for (const key of map.keys()) {
    if (key === terminalId || key.endsWith(suffix)) {
      changed = true;
      break;
    }
  }
  if (!changed) return map;
  const next = new Map(map);
  for (const key of [...next.keys()]) {
    if (key === terminalId || key.endsWith(suffix)) next.delete(key);
  }
  return next;
}

function deleteProjectKeys<V>(
  map: Map<string, V>,
  projectId: string,
  preserveTerminalIds?: Set<string>
): Map<string, V> {
  const prefix = `${projectId}:`;
  let changed = false;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) {
      if (preserveTerminalIds) {
        const terminalId = key.slice(prefix.length);
        if (preserveTerminalIds.has(terminalId)) continue;
      }
      changed = true;
      break;
    }
  }
  if (!changed) return map;
  const next = new Map(map);
  for (const key of [...next.keys()]) {
    if (key.startsWith(prefix)) {
      if (preserveTerminalIds) {
        const terminalId = key.slice(prefix.length);
        if (preserveTerminalIds.has(terminalId)) continue;
      }
      next.delete(key);
    }
  }
  return next;
}

export interface TerminalInputState {
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
  draftInputs: Map<string, string>;
  /** Incremented when voice transcription appends to a draft, so
   *  UI components can detect external draft mutations. */
  voiceDraftRevision: number;
  commandHistory: Map<string, string[]>;
  historyIndex: Map<string, number>;
  tempDraft: Map<string, string>;
  pendingDrafts: Map<string, string>;
  pendingDraftRevision: number;
  setHybridInputEnabled: (enabled: boolean) => void;
  setHybridInputAutoFocus: (enabled: boolean) => void;
  getDraftInput: (terminalId: string, projectId?: string) => string;
  setDraftInput: (terminalId: string, value: string, projectId?: string) => void;
  appendVoiceText: (terminalId: string, text: string, projectId?: string) => void;
  bumpVoiceDraftRevision: () => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
  clearAllDraftInputs: () => void;
  setPendingDraft: (terminalId: string, value: string, projectId?: string) => void;
  popPendingDraft: (terminalId: string, projectId?: string) => string | undefined;
  clearPendingDraft: (terminalId: string, projectId?: string) => void;
  stashedEditorStates: Map<string, EditorState>;
  stashEditorState: (terminalId: string, state: EditorState, projectId?: string) => void;
  popStashedEditorState: (terminalId: string, projectId?: string) => EditorState | undefined;
  hasStashedEditorState: (terminalId: string, projectId?: string) => boolean;
  addToHistory: (terminalId: string, command: string, projectId?: string) => void;
  navigateHistory: (
    terminalId: string,
    direction: "up" | "down",
    currentInput: string,
    projectId?: string
  ) => string | null;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
  getHistoryLength: (terminalId: string, projectId?: string) => number;
  voiceSubmittingPanels: Set<string>;
  setVoiceSubmitting: (panelId: string, submitting: boolean) => void;
  isVoiceSubmitting: (panelId: string) => boolean;
  clearTerminalState: (terminalId: string) => void;
  resetForProjectSwitch: (projectId: string, preserveTerminalIds?: Set<string>) => void;
}

export const useTerminalInputStore = create<TerminalInputState>()((set, get) => ({
  hybridInputEnabled: true,
  hybridInputAutoFocus: true,
  draftInputs: new Map(),
  voiceDraftRevision: 0,
  commandHistory: new Map(),
  historyIndex: new Map(),
  tempDraft: new Map(),
  pendingDrafts: new Map(),
  pendingDraftRevision: 0,
  stashedEditorStates: new Map(),
  voiceSubmittingPanels: new Set(),

  setVoiceSubmitting: (panelId, submitting) =>
    set((state) => {
      if (submitting === state.voiceSubmittingPanels.has(panelId)) return state;
      const next = new Set(state.voiceSubmittingPanels);
      if (submitting) {
        next.add(panelId);
      } else {
        next.delete(panelId);
      }
      return { voiceSubmittingPanels: next };
    }),

  isVoiceSubmitting: (panelId) => get().voiceSubmittingPanels.has(panelId),

  setHybridInputEnabled: (enabled) => set({ hybridInputEnabled: enabled }),
  setHybridInputAutoFocus: (enabled) => set({ hybridInputAutoFocus: enabled }),
  getDraftInput: (terminalId, projectId) => {
    const key = makeDraftKey(terminalId, projectId);
    return get().draftInputs.get(key) ?? "";
  },
  setDraftInput: (terminalId, value, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newDraftInputs = new Map(state.draftInputs);
      if (value === "") {
        newDraftInputs.delete(key);
      } else {
        newDraftInputs.set(key, value);
      }
      return { draftInputs: newDraftInputs };
    }),
  clearDraftInput: (terminalId, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newDraftInputs = new Map(state.draftInputs);
      newDraftInputs.delete(key);
      return { draftInputs: newDraftInputs };
    }),
  appendVoiceText: (terminalId, text, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newDraftInputs = new Map(state.draftInputs);
      const existing = newDraftInputs.get(key) ?? "";
      const separator = existing && !existing.endsWith(" ") ? " " : "";
      newDraftInputs.set(key, existing + separator + text);
      return { draftInputs: newDraftInputs, voiceDraftRevision: state.voiceDraftRevision + 1 };
    }),

  bumpVoiceDraftRevision: () =>
    set((state) => ({ voiceDraftRevision: state.voiceDraftRevision + 1 })),

  clearAllDraftInputs: () =>
    set({
      draftInputs: new Map(),
      pendingDrafts: new Map(),
      pendingDraftRevision: 0,
      stashedEditorStates: new Map(),
      commandHistory: new Map(),
      historyIndex: new Map(),
      tempDraft: new Map(),
    }),

  stashEditorState: (terminalId, editorState, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newStashed = new Map(state.stashedEditorStates);
      newStashed.set(key, editorState);
      return { stashedEditorStates: newStashed };
    }),

  popStashedEditorState: (terminalId, projectId) => {
    const key = makeDraftKey(terminalId, projectId);
    const stashed = get().stashedEditorStates.get(key);
    if (stashed !== undefined) {
      set((state) => {
        const newStashed = new Map(state.stashedEditorStates);
        newStashed.delete(key);
        return { stashedEditorStates: newStashed };
      });
    }
    return stashed;
  },

  hasStashedEditorState: (terminalId, projectId) => {
    const key = makeDraftKey(terminalId, projectId);
    return get().stashedEditorStates.has(key);
  },

  setPendingDraft: (terminalId, value, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newPendingDrafts = new Map(state.pendingDrafts);
      newPendingDrafts.set(key, value);
      return { pendingDrafts: newPendingDrafts };
    }),

  popPendingDraft: (terminalId, projectId) => {
    const key = makeDraftKey(terminalId, projectId);
    const value = get().pendingDrafts.get(key);
    if (value !== undefined) {
      set((state) => {
        const newPendingDrafts = new Map(state.pendingDrafts);
        newPendingDrafts.delete(key);
        return { pendingDrafts: newPendingDrafts };
      });
    }
    return value;
  },

  clearPendingDraft: (terminalId, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newPendingDrafts = new Map(state.pendingDrafts);
      newPendingDrafts.delete(key);
      return { pendingDrafts: newPendingDrafts };
    }),

  addToHistory: (terminalId, command, projectId) =>
    set((state) => {
      const trimmed = command.trim();
      if (trimmed === "") return state;

      const key = makeDraftKey(terminalId, projectId);
      const newHistory = new Map(state.commandHistory);
      const existing = newHistory.get(key) ?? [];

      const lastCommand = existing[existing.length - 1];
      if (lastCommand === trimmed) {
        return state;
      }

      const filtered = existing.filter((cmd) => cmd !== trimmed);
      const updated = [...filtered, trimmed].slice(-MAX_HISTORY_SIZE);
      newHistory.set(key, updated);

      const newIndex = new Map(state.historyIndex);
      newIndex.delete(key);

      const newTempDraft = new Map(state.tempDraft);
      newTempDraft.delete(key);

      return {
        commandHistory: newHistory,
        historyIndex: newIndex,
        tempDraft: newTempDraft,
      };
    }),

  navigateHistory: (terminalId, direction, currentInput, projectId) => {
    const state = get();
    const key = makeDraftKey(terminalId, projectId);
    const history = state.commandHistory.get(key) ?? [];
    if (history.length === 0) return null;

    const currentIndex = state.historyIndex.get(key) ?? -1;
    let newIndex: number;

    if (direction === "up") {
      if (currentIndex === -1) {
        newIndex = history.length - 1;
        set((s) => {
          const newTempDraft = new Map(s.tempDraft);
          newTempDraft.set(key, currentInput);
          const newHistoryIndex = new Map(s.historyIndex);
          newHistoryIndex.set(key, newIndex);
          return { tempDraft: newTempDraft, historyIndex: newHistoryIndex };
        });
      } else if (currentIndex > 0) {
        newIndex = currentIndex - 1;
        set((s) => {
          const newHistoryIndex = new Map(s.historyIndex);
          newHistoryIndex.set(key, newIndex);
          return { historyIndex: newHistoryIndex };
        });
      } else {
        return null;
      }
    } else {
      if (currentIndex === -1) {
        return null;
      } else if (currentIndex < history.length - 1) {
        newIndex = currentIndex + 1;
        set((s) => {
          const newHistoryIndex = new Map(s.historyIndex);
          newHistoryIndex.set(key, newIndex);
          return { historyIndex: newHistoryIndex };
        });
      } else {
        const draft = state.tempDraft.get(key) ?? "";
        set((s) => {
          const newHistoryIndex = new Map(s.historyIndex);
          newHistoryIndex.delete(key);
          const newTempDraft = new Map(s.tempDraft);
          newTempDraft.delete(key);
          return { historyIndex: newHistoryIndex, tempDraft: newTempDraft };
        });
        return draft;
      }
    }

    return history[newIndex] ?? null;
  },

  resetHistoryIndex: (terminalId, projectId) =>
    set((state) => {
      const key = makeDraftKey(terminalId, projectId);
      const newIndex = new Map(state.historyIndex);
      newIndex.delete(key);
      const newTempDraft = new Map(state.tempDraft);
      newTempDraft.delete(key);
      return { historyIndex: newIndex, tempDraft: newTempDraft };
    }),

  getHistoryLength: (terminalId, projectId) => {
    const key = makeDraftKey(terminalId, projectId);
    const history = get().commandHistory.get(key);
    return history?.length ?? 0;
  },

  clearTerminalState: (terminalId) =>
    set((state) => {
      const newDraftInputs = deleteTerminalKeys(state.draftInputs, terminalId);
      const newPendingDrafts = deleteTerminalKeys(state.pendingDrafts, terminalId);
      const newStashed = deleteTerminalKeys(state.stashedEditorStates, terminalId);
      const newHistory = deleteTerminalKeys(state.commandHistory, terminalId);
      const newIndex = deleteTerminalKeys(state.historyIndex, terminalId);
      const newTempDraft = deleteTerminalKeys(state.tempDraft, terminalId);
      const newVoiceSubmitting = state.voiceSubmittingPanels.has(terminalId)
        ? (() => {
            const s = new Set(state.voiceSubmittingPanels);
            s.delete(terminalId);
            return s;
          })()
        : state.voiceSubmittingPanels;

      const changed =
        newDraftInputs !== state.draftInputs ||
        newPendingDrafts !== state.pendingDrafts ||
        newStashed !== state.stashedEditorStates ||
        newHistory !== state.commandHistory ||
        newIndex !== state.historyIndex ||
        newTempDraft !== state.tempDraft ||
        newVoiceSubmitting !== state.voiceSubmittingPanels;

      if (!changed) return state;

      return {
        draftInputs: newDraftInputs,
        pendingDrafts: newPendingDrafts,
        stashedEditorStates: newStashed,
        commandHistory: newHistory,
        historyIndex: newIndex,
        tempDraft: newTempDraft,
        voiceSubmittingPanels: newVoiceSubmitting,
      };
    }),

  resetForProjectSwitch: (projectId, preserveTerminalIds) =>
    set((state) => {
      const newDraftInputs = deleteProjectKeys(state.draftInputs, projectId, preserveTerminalIds);
      const newPendingDrafts = deleteProjectKeys(
        state.pendingDrafts,
        projectId,
        preserveTerminalIds
      );
      const newStashed = deleteProjectKeys(
        state.stashedEditorStates,
        projectId,
        preserveTerminalIds
      );
      const newHistory = deleteProjectKeys(state.commandHistory, projectId, preserveTerminalIds);
      const newIndex = deleteProjectKeys(state.historyIndex, projectId, preserveTerminalIds);
      const newTempDraft = deleteProjectKeys(state.tempDraft, projectId, preserveTerminalIds);

      const changed =
        newDraftInputs !== state.draftInputs ||
        newPendingDrafts !== state.pendingDrafts ||
        newStashed !== state.stashedEditorStates ||
        newHistory !== state.commandHistory ||
        newIndex !== state.historyIndex ||
        newTempDraft !== state.tempDraft;

      if (!changed) return state;

      return {
        draftInputs: newDraftInputs,
        pendingDrafts: newPendingDrafts,
        stashedEditorStates: newStashed,
        commandHistory: newHistory,
        historyIndex: newIndex,
        tempDraft: newTempDraft,
      };
    }),
}));
