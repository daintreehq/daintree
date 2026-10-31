import { create } from "zustand";
import type { EditorState } from "@codemirror/state";
import { makeDraftKey } from "@/lib/draftKey";
import type { TerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  VOICE_RECENT_PROMPTS_MAX,
  VOICE_RECENT_PROMPT_MAX_CHARS,
} from "@shared/config/voiceCorrection";

const MAX_HISTORY_SIZE = 100;
// Terminals with sends on record. A closed pane clears its own; this bounds the
// ones that never close here, such as another project's agent a reply went to.
const MAX_SENT_PROMPT_TERMINALS = 64;

/** A prompt as it was sent to a terminal, as the composer wrote it, for dictation cleanup. */
export interface SentPrompt {
  text: string;
  sentAt: number;
  /** Counts every send to the terminal, so a window over them never moves with the cap. */
  seq: number;
}

// By the terminal sent to rather than the composer that sent it, so the pane
// and a Canopy reply typing to the same agent share one record. A view keeps
// only what it sent.
function sentPromptKey(terminalId: string): string {
  return makeDraftKey(terminalId, getViewWorkspaceId() ?? undefined);
}

// Cut when recorded, so a pasted wall of text is kept only as its opening; by
// UTF-16 unit, never splitting a surrogate pair, whatever the language. The
// run of printable ASCII the cut goes through goes with it, however long:
// cut short, a key or a URL's password (`postgres://user:pass` without its
// `@host`) is too little for cleanup's redaction to know.
function boundSentPrompt(text: string): string {
  if (text.length <= VOICE_RECENT_PROMPT_MAX_CHARS) return text;
  let cut = text.slice(0, VOICE_RECENT_PROMPT_MAX_CHARS - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  if (/[!-~]/.test(text.charAt(cut.length))) cut = cut.replace(/[!-~]+$/, "");
  return `${cut}…`;
}

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

/**
 * The agent a user last actually typed into — the routing target for the
 * type-anywhere rescue (#11134).
 *
 * Deliberately NOT derived from panel selection or `lastFocusedTerminalByWorktree`:
 * selection is overloaded by fleet membership and can point at a file or browser
 * panel, and focus is not typing. This is recorded only from real `input.type`
 * transactions in an agent's hybrid editor.
 *
 * `workspaceId` pins the record to the view that produced it, so a sibling
 * project view can never route into it.
 */
export interface LastTypedAgentTarget {
  workspaceId: string;
  terminalId: string;
}

/**
 * A fleet member's own draft, set aside while the fleet's draft is mirrored
 * over it (#14949). `draft` is null for a member whose own draft became the
 * fleet's: it was the primary before anything was mirrored into it, so the
 * fleet's text is its text and there is nothing to give back.
 */
export interface FleetDraftHold {
  terminalId: string;
  draft: string | null;
}

export interface TerminalInputState {
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
  draftInputs: Map<string, string>;
  /** Incremented when something outside the editor writes a draft (voice
   *  transcription, prompt history, the type-anywhere rescue), so a mounted
   *  editor can detect the external mutation and sync its document. */
  externalDraftRevision: number;
  /**
   * The latest outside write that moves the composer's caret to the end of
   * the draft. Writes that keep it (dictation lands where its anchor is, not
   * where the user is typing) don't advance it.
   */
  caretMovingDraftRevision: number;
  /**
   * The latest outside write that puts a different draft in place (a prompt
   * recalled from history) rather than adding to the one there.
   */
  draftReplacingRevision: number;
  lastTypedAgentTarget: LastTypedAgentTarget | null;
  commandHistory: Map<string, string[]>;
  /** The latest sends to each terminal, in send order, repeats and all; never reordered. */
  sentPrompts: Map<string, SentPrompt[]>;
  historyIndex: Map<string, number>;
  tempDraft: Map<string, string>;
  pendingDrafts: Map<string, string>;
  pendingDraftRevision: number;
  setHybridInputEnabled: (enabled: boolean) => void;
  setHybridInputAutoFocus: (enabled: boolean) => void;
  getDraftInput: (terminalId: string, projectId?: string) => string;
  setDraftInput: (terminalId: string, value: string, projectId?: string) => void;
  bumpExternalDraftRevision: (options?: {
    keepsSelection?: boolean;
    replacesDraft?: boolean;
  }) => void;
  recordLastTypedAgentTarget: (terminalId: string, workspaceId: string) => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
  clearAllDraftInputs: () => void;
  setPendingDraft: (terminalId: string, value: string, projectId?: string) => void;
  popPendingDraft: (terminalId: string, projectId?: string) => string | undefined;
  clearPendingDraft: (terminalId: string, projectId?: string) => void;
  stashedEditorStates: Map<string, EditorState>;
  /** By draft key, for every fleet member the fleet's draft has reached. */
  fleetDraftHolds: Map<string, FleetDraftHold>;
  /**
   * The primary's draft into each other armed pane. A pane's own draft is held
   * the first time the fleet's replaces it, unless its draft is the fleet's.
   */
  mirrorFleetDraft: (
    primaryId: string,
    value: string,
    armedIds: ReadonlySet<string>,
    projectId?: string
  ) => void;
  /** Every member not in `fleetIds` gets its held draft back and is forgotten. */
  releaseFleetDraftHolds: (fleetIds: ReadonlySet<string>) => void;
  stashEditorState: (terminalId: string, state: EditorState, projectId?: string) => void;
  popStashedEditorState: (terminalId: string, projectId?: string) => EditorState | undefined;
  hasStashedEditorState: (terminalId: string, projectId?: string) => boolean;
  addToHistory: (terminalId: string, command: string, projectId?: string) => void;
  /**
   * Notes a prompt sent to `terminalId`, as written, for its dictations'
   * cleanup. Returns the record, null for a blank prompt.
   */
  recordSentPrompt: (terminalId: string, text: string, sentAt?: number) => SentPrompt | null;
  /** Takes back a send the terminal turned down, if it is still on record. */
  retractSentPrompt: (terminalId: string, sent: SentPrompt) => void;
  getSentPrompts: (terminalId: string) => readonly SentPrompt[];
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
  getProjectDraftInputs: (projectId: string) => Record<string, string>;
  restoreProjectDraftInputs: (projectId: string, inputs: Record<string, string>) => void;
  /** Distinct project ids that currently hold at least one draft key. Used by
   *  the close-time draft flush to know which projects to persist (#11352). */
  getDraftProjectIds: () => string[];
}

/**
 * The surface every arrival at an agent pane puts the keyboard on, before
 * availability: the **Focus first** setting, and nothing the user did in some
 * other pane.
 */
export const selectHomeFocusTarget = (state: TerminalInputState): TerminalFocusTarget =>
  state.hybridInputAutoFocus ? "hybridInput" : "xterm";

export const useTerminalInputStore = create<TerminalInputState>()((set, get) => ({
  hybridInputEnabled: true,
  hybridInputAutoFocus: true,
  draftInputs: new Map(),
  externalDraftRevision: 0,
  caretMovingDraftRevision: 0,
  draftReplacingRevision: 0,
  lastTypedAgentTarget: null,
  commandHistory: new Map(),
  sentPrompts: new Map(),
  historyIndex: new Map(),
  tempDraft: new Map(),
  pendingDrafts: new Map(),
  pendingDraftRevision: 0,
  stashedEditorStates: new Map(),
  fleetDraftHolds: new Map(),
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
      const existing = state.draftInputs.get(key);
      // Short-circuit on no-op writes — fleet mirroring otherwise causes
      // every keystroke to fan out N redundant Map-replacements that wake
      // every draft subscriber for nothing.
      if (value === "" ? existing === undefined : existing === value) {
        return state;
      }
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
  bumpExternalDraftRevision: (options) =>
    set((state) => {
      const externalDraftRevision = state.externalDraftRevision + 1;
      return {
        externalDraftRevision,
        ...(options?.keepsSelection ? {} : { caretMovingDraftRevision: externalDraftRevision }),
        ...(options?.replacesDraft ? { draftReplacingRevision: externalDraftRevision } : {}),
      };
    }),

  recordLastTypedAgentTarget: (terminalId, workspaceId) =>
    set((state) => {
      const current = state.lastTypedAgentTarget;
      if (current?.terminalId === terminalId && current.workspaceId === workspaceId) {
        return state;
      }
      return { lastTypedAgentTarget: { terminalId, workspaceId } };
    }),

  clearAllDraftInputs: () =>
    set({
      draftInputs: new Map(),
      pendingDrafts: new Map(),
      pendingDraftRevision: 0,
      stashedEditorStates: new Map(),
      fleetDraftHolds: new Map(),
      commandHistory: new Map(),
      historyIndex: new Map(),
      tempDraft: new Map(),
      lastTypedAgentTarget: null,
    }),

  mirrorFleetDraft: (primaryId, value, armedIds, projectId) =>
    set((state) => {
      let holds: Map<string, FleetDraftHold> | null = null;
      let drafts: Map<string, string> | null = null;
      const primaryKey = makeDraftKey(primaryId, projectId);
      if (!state.fleetDraftHolds.has(primaryKey)) {
        holds = new Map(state.fleetDraftHolds);
        holds.set(primaryKey, { terminalId: primaryId, draft: null });
      }
      for (const id of armedIds) {
        if (id === primaryId) continue;
        const key = makeDraftKey(id, projectId);
        const existing = state.draftInputs.get(key) ?? "";
        if (existing === value) continue;
        if (!(holds ?? state.fleetDraftHolds).has(key)) {
          holds ??= new Map(state.fleetDraftHolds);
          holds.set(key, { terminalId: id, draft: existing });
        }
        drafts ??= new Map(state.draftInputs);
        if (value === "") drafts.delete(key);
        else drafts.set(key, value);
      }
      if (holds === null && drafts === null) return state;
      return {
        ...(holds && { fleetDraftHolds: holds }),
        ...(drafts && { draftInputs: drafts }),
      };
    }),

  releaseFleetDraftHolds: (fleetIds) =>
    set((state) => {
      let holds: Map<string, FleetDraftHold> | null = null;
      let drafts: Map<string, string> | null = null;
      for (const [key, hold] of state.fleetDraftHolds) {
        if (fleetIds.has(hold.terminalId)) continue;
        holds ??= new Map(state.fleetDraftHolds);
        holds.delete(key);
        if (hold.draft === null) continue;
        if ((state.draftInputs.get(key) ?? "") === hold.draft) continue;
        drafts ??= new Map(state.draftInputs);
        if (hold.draft === "") drafts.delete(key);
        else drafts.set(key, hold.draft);
      }
      if (holds === null) return state;
      return { fleetDraftHolds: holds, ...(drafts && { draftInputs: drafts }) };
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

  recordSentPrompt: (terminalId, text, sentAt = Date.now()) => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const key = sentPromptKey(terminalId);
    const existing = get().sentPrompts.get(key) ?? [];
    const sent: SentPrompt = {
      text: boundSentPrompt(trimmed),
      sentAt,
      seq: (existing[existing.length - 1]?.seq ?? -1) + 1,
    };
    set((state) => {
      const next = new Map(state.sentPrompts);
      // Re-inserted, so the map's first key is the terminal sent to longest ago.
      next.delete(key);
      next.set(key, [...existing, sent].slice(-VOICE_RECENT_PROMPTS_MAX));
      if (next.size > MAX_SENT_PROMPT_TERMINALS) next.delete(next.keys().next().value!);
      return { sentPrompts: next };
    });
    return sent;
  },

  // By the record itself: a count that restarted after the terminal's record
  // was cleared can give a newer send the same seq.
  retractSentPrompt: (terminalId, sent) =>
    set((state) => {
      const key = sentPromptKey(terminalId);
      const existing = state.sentPrompts.get(key);
      if (!existing?.includes(sent)) return state;
      const next = new Map(state.sentPrompts);
      next.set(
        key,
        existing.filter((prompt) => prompt !== sent)
      );
      return { sentPrompts: next };
    }),

  getSentPrompts: (terminalId) => get().sentPrompts.get(sentPromptKey(terminalId)) ?? [],

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
      const newHolds = deleteTerminalKeys(state.fleetDraftHolds, terminalId);
      const newHistory = deleteTerminalKeys(state.commandHistory, terminalId);
      const newSent = deleteTerminalKeys(state.sentPrompts, terminalId);
      const newIndex = deleteTerminalKeys(state.historyIndex, terminalId);
      const newTempDraft = deleteTerminalKeys(state.tempDraft, terminalId);
      const newVoiceSubmitting = state.voiceSubmittingPanels.has(terminalId)
        ? (() => {
            const s = new Set(state.voiceSubmittingPanels);
            s.delete(terminalId);
            return s;
          })()
        : state.voiceSubmittingPanels;

      // A removed terminal can never be a routing target again.
      const newLastTyped =
        state.lastTypedAgentTarget?.terminalId === terminalId ? null : state.lastTypedAgentTarget;

      const changed =
        newDraftInputs !== state.draftInputs ||
        newPendingDrafts !== state.pendingDrafts ||
        newStashed !== state.stashedEditorStates ||
        newHolds !== state.fleetDraftHolds ||
        newHistory !== state.commandHistory ||
        newSent !== state.sentPrompts ||
        newIndex !== state.historyIndex ||
        newTempDraft !== state.tempDraft ||
        newVoiceSubmitting !== state.voiceSubmittingPanels ||
        newLastTyped !== state.lastTypedAgentTarget;

      if (!changed) return state;

      return {
        draftInputs: newDraftInputs,
        pendingDrafts: newPendingDrafts,
        stashedEditorStates: newStashed,
        fleetDraftHolds: newHolds,
        commandHistory: newHistory,
        sentPrompts: newSent,
        historyIndex: newIndex,
        tempDraft: newTempDraft,
        voiceSubmittingPanels: newVoiceSubmitting,
        lastTypedAgentTarget: newLastTyped,
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
      const newHolds = deleteProjectKeys(state.fleetDraftHolds, projectId, preserveTerminalIds);
      const newHistory = deleteProjectKeys(state.commandHistory, projectId, preserveTerminalIds);
      const newSent = deleteProjectKeys(state.sentPrompts, projectId, preserveTerminalIds);
      const newIndex = deleteProjectKeys(state.historyIndex, projectId, preserveTerminalIds);
      const newTempDraft = deleteProjectKeys(state.tempDraft, projectId, preserveTerminalIds);

      // Drop the routing target only if this switch actually discards it — a
      // preserved terminal keeps its claim.
      const target = state.lastTypedAgentTarget;
      const newLastTyped =
        target !== null &&
        target.workspaceId === projectId &&
        !preserveTerminalIds?.has(target.terminalId)
          ? null
          : target;

      const changed =
        newDraftInputs !== state.draftInputs ||
        newPendingDrafts !== state.pendingDrafts ||
        newStashed !== state.stashedEditorStates ||
        newHolds !== state.fleetDraftHolds ||
        newHistory !== state.commandHistory ||
        newSent !== state.sentPrompts ||
        newIndex !== state.historyIndex ||
        newTempDraft !== state.tempDraft ||
        newLastTyped !== state.lastTypedAgentTarget;

      if (!changed) return state;

      return {
        draftInputs: newDraftInputs,
        pendingDrafts: newPendingDrafts,
        stashedEditorStates: newStashed,
        fleetDraftHolds: newHolds,
        commandHistory: newHistory,
        sentPrompts: newSent,
        historyIndex: newIndex,
        tempDraft: newTempDraft,
        lastTypedAgentTarget: newLastTyped,
      };
    }),

  getProjectDraftInputs: (projectId) => {
    const prefix = `${projectId}:`;
    const result: Record<string, string> = {};
    for (const [key, value] of get().draftInputs) {
      if (key.startsWith(prefix) && value) {
        const terminalId = key.slice(prefix.length);
        if (terminalId) {
          result[terminalId] = value;
        }
      }
    }
    return result;
  },

  restoreProjectDraftInputs: (projectId, inputs) =>
    set((state) => {
      const newDraftInputs = new Map(state.draftInputs);
      let newHolds = state.fleetDraftHolds;
      for (const [terminalId, value] of Object.entries(inputs)) {
        if (terminalId && value) {
          const key = `${projectId}:${terminalId}`;
          newDraftInputs.set(key, value);
          // Newer than the draft held for the pane, which leaving the fleet
          // would otherwise put back over it.
          if (newHolds.has(key)) {
            if (newHolds === state.fleetDraftHolds) newHolds = new Map(newHolds);
            newHolds.delete(key);
          }
        }
      }
      return { draftInputs: newDraftInputs, fleetDraftHolds: newHolds };
    }),

  getDraftProjectIds: () => {
    const ids = new Set<string>();
    for (const key of get().draftInputs.keys()) {
      // Composite keys are `${projectId}:${terminalId}`; a bare terminalId key
      // (no project context) has no per-project persistence target, so skip it.
      const idx = key.indexOf(":");
      if (idx > 0) {
        ids.add(key.slice(0, idx));
      }
    }
    return [...ids];
  },
}));
