import { create } from "zustand";
import type { VoiceInputStatus } from "@shared/types";

export interface VoiceRecordingTarget {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
}

export interface PendingCorrection {
  /** Character offset in the draft where the uncorrected segment starts. */
  segmentStart: number;
  /** The raw text that was inserted and is awaiting correction. */
  rawText: string;
}

interface VoiceTranscriptBuffer {
  liveText: string;
  completedSegments: string[];
  projectId?: string;
  /** Draft length snapshot taken before the first delta of a segment. */
  draftLengthAtSegmentStart: number;
  /** Segments awaiting AI correction — shown dimmed in the editor. */
  pendingCorrections: PendingCorrection[];
  /** Draft length at the start of the current paragraph (-1 = not set). */
  activeParagraphStart: number;
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
  setDraftLengthAtSegmentStart: (panelId: string, length: number) => void;
  completeSegment: (text: string) => void;
  addPendingCorrection: (panelId: string, segmentStart: number, rawText: string) => void;
  resolvePendingCorrection: (panelId: string, rawText: string) => void;
  getPendingCorrections: (panelId: string) => PendingCorrection[];
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
      draftLengthAtSegmentStart: -1,
      pendingCorrections: [],
      activeParagraphStart: -1,
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
          projectId: target.projectId,
          draftLengthAtSegmentStart: -1,
          activeParagraphStart: -1,
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
          },
        },
      };
    }),

  setDraftLengthAtSegmentStart: (panelId, length) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      if (buffer.draftLengthAtSegmentStart >= 0) return state;
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, draftLengthAtSegmentStart: length },
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
              draftLengthAtSegmentStart: -1,
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
            draftLengthAtSegmentStart: -1,
            completedSegments: [...buffer.completedSegments, normalized],
          },
        },
      };
    }),

  addPendingCorrection: (panelId, segmentStart, rawText) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: {
            ...buffer,
            pendingCorrections: [...buffer.pendingCorrections, { segmentStart, rawText }],
          },
        },
      };
    }),

  resolvePendingCorrection: (panelId, rawText) =>
    set((state) => {
      const buffer = getBuffer(state.panelBuffers, panelId);
      const idx = buffer.pendingCorrections.findIndex((p) => p.rawText === rawText);
      if (idx === -1) return state;
      const next = [...buffer.pendingCorrections];
      next.splice(idx, 1);
      return {
        panelBuffers: {
          ...state.panelBuffers,
          [panelId]: { ...buffer, pendingCorrections: next },
        },
      };
    }),

  getPendingCorrections: (panelId) => {
    return getBuffer(get().panelBuffers, panelId).pendingCorrections;
  },

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
            completedSegments: [],
            activeParagraphStart: -1,
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
