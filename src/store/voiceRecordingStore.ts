import { create } from "zustand";
import type { VoiceInputStatus, VoiceTranscriptPhase } from "@shared/types";

export interface VoiceRecordingTarget {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
}

interface VoiceTranscriptBuffer {
  liveText: string;
  completedSegments: string[];
  projectId?: string;
  /** Draft length snapshot taken before the first delta of the session. */
  sessionDraftStart: number;
  /** CodeMirror position where the next utterance's final text will be inserted. */
  insertPoint: number;
  /** Draft length at the start of the current paragraph (-1 = not set). */
  activeParagraphStart: number;
  /** Explicit transcript lifecycle phase — derived from and updated alongside buffer state. */
  transcriptPhase: VoiceTranscriptPhase;
  /**
   * Draft range currently undergoing the post-stop whole-passage AI cleanup
   * pass (null = none). Drives the `cm-voice-pending-ai` editor decoration.
   */
  correctionRange: { from: number; to: number } | null;
}

interface VoiceAnnouncement {
  id: number;
  text: string;
}

interface FinishSessionOptions {
  nextStatus?: VoiceInputStatus;
  preserveLiveText?: boolean;
}

interface VoiceRecordingState {
  isConfigured: boolean;
  /** Whether AI correction is enabled for the current session. */
  correctionEnabled: boolean;
  status: VoiceInputStatus;
  errorMessage: string | null;
  activeTarget: VoiceRecordingTarget | null;
  elapsedSeconds: number;
  audioLevel: number;
  panelBuffers: Record<string, VoiceTranscriptBuffer>;
  announcement: VoiceAnnouncement | null;
  setConfigured: (isConfigured: boolean) => void;
  setCorrectionEnabled: (enabled: boolean) => void;
  setAudioLevel: (level: number) => void;
  beginSession: (target: VoiceRecordingTarget) => void;
  setStatus: (status: VoiceInputStatus) => void;
  setError: (message: string | null) => void;
  setElapsedSeconds: (seconds: number) => void;
  appendDelta: (delta: string) => void;
  setSessionDraftStart: (panelId: string, length: number) => void;
  setInsertPoint: (panelId: string, length: number) => void;
  completeSegment: (text: string) => void;
  setCorrectionRange: (panelId: string, range: { from: number; to: number } | null) => void;
  setActiveParagraphStart: (panelId: string, length: number) => void;
  resetParagraphState: (panelId: string) => void;
  finishSession: (options?: FinishSessionOptions) => void;
  consumeCompletedSegments: (panelId: string) => string[];
  clearPanelBuffer: (panelId: string) => void;
  announce: (text: string) => void;
  clearAnnouncement: () => void;
}

function getBuffer(
  panelBuffers: Record<string, VoiceTranscriptBuffer>,
  panelId: string
): VoiceTranscriptBuffer {
  return (
    panelBuffers[panelId] ?? {
      liveText: "",
      completedSegments: [],
      sessionDraftStart: -1,
      insertPoint: -1,
      activeParagraphStart: -1,
      transcriptPhase: "idle" as VoiceTranscriptPhase,
      correctionRange: null,
    }
  );
}

export const useVoiceRecordingStore = create<VoiceRecordingState>()((set, get) => ({
  isConfigured: false,
  correctionEnabled: false,
  status: "idle",
  errorMessage: null,
  activeTarget: null,
  elapsedSeconds: 0,
  audioLevel: 0,
  panelBuffers: {},
  announcement: null,

  setConfigured: (isConfigured) => set({ isConfigured }),

  setCorrectionEnabled: (correctionEnabled) => set({ correctionEnabled }),

  setAudioLevel: (audioLevel) => set({ audioLevel }),

  beginSession: (target) =>
    set((state) => ({
      activeTarget: target,
      status: "connecting",
      errorMessage: null,
      elapsedSeconds: 0,
      panelBuffers: {
        ...state.panelBuffers,
        [target.panelId]: {
          ...getBuffer(state.panelBuffers, target.panelId),
          liveText: "",
          completedSegments: [],
          projectId: target.projectId,
          sessionDraftStart: -1,
          insertPoint: -1,
          activeParagraphStart: -1,
          transcriptPhase: "idle" as VoiceTranscriptPhase,
          correctionRange: null,
        },
      },
    })),

  setStatus: (status) => set({ status }),

  setError: (message) => set({ errorMessage: message }),

  setElapsedSeconds: (elapsedSeconds) => set({ elapsedSeconds }),

  appendDelta: (delta) =>
    set((state) => {
      const panelId = state.activeTarget?.panelId;
      if (!panelId || !delta) return state;
      const buffer = getBuffer(state.panelBuffers, panelId);
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: {
            ...buffer,
            liveText: buffer.liveText + delta,
            transcriptPhase: "interim" as VoiceTranscriptPhase,
          },
        },
      };
    }),

  setSessionDraftStart: (panelId, length) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      if (buffer.sessionDraftStart >= 0) return state;
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, sessionDraftStart: length },
        },
      };
    }),

  setInsertPoint: (panelId, length) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      if (buffer.insertPoint >= 0) return state;
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, insertPoint: length },
        },
      };
    }),

  completeSegment: (text) =>
    set((state) => {
      const panelId = state.activeTarget?.panelId;
      if (!panelId) return state;

      const buffer = getBuffer(state.panelBuffers, panelId);
      const normalized = text.trim() || buffer.liveText.trim();
      if (!normalized) {
        return {
          panelBuffers: {
            ...state.panelBuffers,
            [panelId]: {
              ...buffer,
              liveText: "",
              insertPoint: -1,
              transcriptPhase: "idle" as VoiceTranscriptPhase,
            },
          },
        };
      }

      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: {
            ...buffer,
            liveText: "",
            insertPoint: -1,
            completedSegments: [...buffer.completedSegments, normalized],
            transcriptPhase: "utterance_final" as VoiceTranscriptPhase,
          },
        },
      };
    }),

  setCorrectionRange: (panelId, range) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      if (buffer.correctionRange === range) return state;
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, correctionRange: range },
        },
      };
    }),

  setActiveParagraphStart: (panelId, length) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      if (buffer.activeParagraphStart >= 0) return state;
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, activeParagraphStart: length },
        },
      };
    }),

  resetParagraphState: (panelId) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: {
            ...buffer,
            liveText: "",
            completedSegments: [],
            insertPoint: -1,
            activeParagraphStart: -1,
            transcriptPhase: "idle" as VoiceTranscriptPhase,
          },
        },
      };
    }),

  finishSession: ({ nextStatus = "idle", preserveLiveText = false } = {}) =>
    set((state) => {
      const panelId = state.activeTarget?.panelId;
      if (!panelId) {
        return {
          activeTarget: null,
          status: nextStatus,
          elapsedSeconds: 0,
          audioLevel: 0,
        };
      }

      const buffer = getBuffer(state.panelBuffers, panelId);
      const normalizedLiveText = buffer.liveText.trim();
      const completedSegments =
        preserveLiveText && normalizedLiveText
          ? [...buffer.completedSegments, normalizedLiveText]
          : buffer.completedSegments;

      return {
        activeTarget: null,
        status: nextStatus,
        elapsedSeconds: 0,
        audioLevel: 0,
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: {
            ...buffer,
            liveText: "",
            completedSegments,
            transcriptPhase: "idle" as VoiceTranscriptPhase,
          },
        },
      };
    }),

  consumeCompletedSegments: (panelId) => {
    const buffer = getBuffer(get().panelBuffers, panelId);
    if (buffer.completedSegments.length === 0) {
      return [];
    }

    const completedSegments = [...buffer.completedSegments];
    set((state) => ({
      panelBuffers: {
        ...state.panelBuffers,
        [panelId]: {
          ...getBuffer(state.panelBuffers, panelId),
          completedSegments: [],
        },
      },
    }));
    return completedSegments;
  },

  clearPanelBuffer: (panelId) =>
    set((state) => {
      if (!(panelId in state.panelBuffers)) return state;
      const next = { ...state.panelBuffers };
      delete next[panelId];
      return { panelBuffers: next };
    }),

  announce: (text) =>
    set({
      announcement: {
        id: Date.now(),
        text,
      },
    }),

  clearAnnouncement: () => set({ announcement: null }),
}));
