import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import type { VoiceInputError, VoiceInputStatus, VoiceTranscriptPhase } from "@shared/types";
import { createDebouncedSafeJSONStorage } from "./persistence/safeStorage";
import type { PersistWriteMergeContext } from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

export interface VoiceRecordingTarget {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
}

/**
 * Display-only metadata for a previously used dictation target. Panel IDs are
 * ephemeral and don't survive restarts, so persisted entries deliberately omit
 * `panelId` — the list is a memory aid, not a routing key. A live `panelId` is
 * attached at runtime when the entry is freshly recorded (same session) so the
 * context menu can offer a one-click recall while the panel still exists.
 */
export interface RecentDictationTarget {
  /** Live panel reference; absent for entries restored from persistence. */
  panelId?: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
  /** Wall-clock timestamp of the last use; drives MRU ordering. */
  lastUsedAt: number;
}

const MAX_RECENT_TARGETS = 3;

type VoiceRecordingPersistedState = { recentTargets: RecentDictationTarget[] };

function toRecentTargets(
  value: StorageValue<VoiceRecordingPersistedState> | null
): RecentDictationTarget[] {
  const list = value?.state?.recentTargets;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is RecentDictationTarget =>
      entry !== null && typeof entry === "object" && typeof entry.lastUsedAt === "number"
  );
}

/**
 * Logical identity of a persisted recent target. Persisted entries have `panelId`
 * stripped (partialize), so identity is the `(worktreeId, panelTitle)` tuple the
 * store uses to resolve a rehydrated entry back to a live panel. An entry with
 * neither has no stable logical key, so it is fingerprinted by its full persisted
 * content (`lastUsedAt` included): identical copies from two views collapse
 * instead of duplicating across flushes, while genuinely distinct anonymous
 * entries stay separate.
 */
function recentTargetIdentity(target: RecentDictationTarget): string {
  if (target.worktreeId || target.panelTitle) {
    return `id:${target.worktreeId ?? ""}|${target.panelTitle ?? ""}`;
  }
  return `anon:${target.projectId ?? ""}|${target.projectName ?? ""}|${target.worktreeLabel ?? ""}|${target.lastUsedAt}`;
}

/**
 * Baseline-aware three-way merge for voice-recording writes across project views
 * (issue #11351). `recentTargets` is one global MRU list (cap 3) that any view
 * appends to, and the store's high-frequency transient setters (`setAudioLevel`,
 * `setElapsedSeconds`) trigger debounced persist writes of it — so a stale view's
 * flush would otherwise drop a sibling's just-recorded target. We union this
 * writer's list with the freshest on-disk list by logical identity, keep the
 * more-recently-used entry on collision, and re-sort/cap to the globally three
 * most-recent — the same recency semantics the store's own `recordRecentTarget`
 * applies within a single view.
 */
function mergeVoiceRecordingPersistedWrite({
  onDisk,
  incoming,
}: PersistWriteMergeContext<VoiceRecordingPersistedState>): StorageValue<VoiceRecordingPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const byIdentity = new Map<string, RecentDictationTarget>();
  for (const target of [...toRecentTargets(incoming), ...toRecentTargets(onDisk)]) {
    const identity = recentTargetIdentity(target);
    const existing = byIdentity.get(identity);
    if (!existing || target.lastUsedAt > existing.lastUsedAt) {
      byIdentity.set(identity, target);
    }
  }
  const merged = [...byIdentity.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECENT_TARGETS);
  return { version: incoming.version, state: { recentTargets: merged } };
}

interface VoiceTranscriptBuffer {
  liveText: string;
  completedSegments: string[];
  projectId?: string;
  /** Draft length snapshot taken before the first delta of the session. */
  sessionDraftStart: number;
  /** Draft length snapshot taken before the first delta of a segment. */
  draftLengthAtSegmentStart: number;
  /** Draft length at the start of the current paragraph (-1 = not set). */
  activeParagraphStart: number;
  /** Explicit transcript lifecycle phase — derived from and updated alongside buffer state. */
  transcriptPhase: VoiceTranscriptPhase;
  /**
   * Draft range currently undergoing the post-stop whole-passage AI cleanup
   * pass (null = none). Drives the `cm-voice-pending-ai` editor decoration.
   */
  correctionRange: { from: number; to: number } | null;
  /**
   * The dictated text as it settled after the post-stop processing pass (AI
   * correction if enabled, else the raw transcription). Diffed against the
   * user's final edits at send time to learn dictionary words. Runtime-only,
   * ephemeral per session, never persisted — see [[#9514]] separate durable vs
   * in-session state.
   */
  sessionCorrectedText: string | null;
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
  /** Whether manual corrections to dictated text surface as suggested dictionary words. */
  learnFromCorrections: boolean;
  status: VoiceInputStatus;
  lastError: VoiceInputError | null;
  activeTarget: VoiceRecordingTarget | null;
  /**
   * Pinned dictation target. When set, `toggleFocusedPanel` routes here
   * regardless of which panel owns focus. Runtime-only: panelId is ephemeral,
   * so this is stripped from the persisted blob.
   */
  lockedTarget: VoiceRecordingTarget | null;
  /**
   * Most-recently used dictation targets (max 3, MRU-ordered). Persisted as
   * display-only metadata; the panelId field is dropped on rehydrate so a
   * stale id can't silently route dictation to a non-existent panel.
   */
  recentTargets: RecentDictationTarget[];
  elapsedSeconds: number;
  audioLevel: number;
  panelBuffers: Record<string, VoiceTranscriptBuffer>;
  announcement: VoiceAnnouncement | null;
  setConfigured: (isConfigured: boolean) => void;
  setCorrectionEnabled: (enabled: boolean) => void;
  setLearnFromCorrections: (enabled: boolean) => void;
  setSessionCorrectedText: (panelId: string, text: string | null) => void;
  setAudioLevel: (level: number) => void;
  setArming: (target: VoiceRecordingTarget) => void;
  beginSession: (target: VoiceRecordingTarget) => void;
  setStatus: (status: VoiceInputStatus) => void;
  setLastError: (error: VoiceInputError | null) => void;
  setElapsedSeconds: (seconds: number) => void;
  appendDelta: (delta: string) => void;
  setSessionDraftStart: (panelId: string, length: number) => void;
  setDraftLengthAtSegmentStart: (panelId: string, length: number) => void;
  completeSegment: (text: string) => void;
  setCorrectionRange: (panelId: string, range: { from: number; to: number } | null) => void;
  setActiveParagraphStart: (panelId: string, length: number) => void;
  resetParagraphState: (panelId: string) => void;
  finishSession: (options?: FinishSessionOptions) => void;
  consumeCompletedSegments: (panelId: string) => string[];
  clearPanelBuffer: (panelId: string) => void;
  announce: (text: string) => void;
  clearAnnouncement: () => void;
  lockTarget: (target: VoiceRecordingTarget) => void;
  unlockTarget: () => void;
  /** Clears the lock only if it matches `panelId`; safe to call for any removed panel. */
  clearLockedTarget: (panelId: string) => void;
  /** Records or refreshes a recent-targets entry (MRU-ordered, capped at 3). */
  recordRecentTarget: (target: VoiceRecordingTarget) => void;
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
      draftLengthAtSegmentStart: -1,
      activeParagraphStart: -1,
      transcriptPhase: "idle" as VoiceTranscriptPhase,
      correctionRange: null,
      sessionCorrectedText: null,
    }
  );
}

export const useVoiceRecordingStore = create<VoiceRecordingState>()(
  persist(
    (set, get) => ({
      isConfigured: false,
      correctionEnabled: false,
      learnFromCorrections: true,
      status: "idle",
      lastError: null,
      activeTarget: null,
      lockedTarget: null,
      recentTargets: [],
      elapsedSeconds: 0,
      audioLevel: 0,
      panelBuffers: {},
      announcement: null,

      setConfigured: (isConfigured) => set({ isConfigured }),

      setCorrectionEnabled: (correctionEnabled) => set({ correctionEnabled }),

      setLearnFromCorrections: (learnFromCorrections) => set({ learnFromCorrections }),

      setSessionCorrectedText: (panelId, text) =>
        set((state) => {
          const buffer = getBuffer(state.panelBuffers, panelId);
          if (buffer.sessionCorrectedText === text) return state;
          return {
            panelBuffers: {
              ...state.panelBuffers,
              [panelId]: { ...buffer, sessionCorrectedText: text },
            },
          };
        }),

      setLastError: (error) => set({ lastError: error }),

      setAudioLevel: (audioLevel) => set({ audioLevel }),

      // Atomic single-set transition into the pre-audio confirmation phase.
      // Fires synchronously before any await in start() so the target panel
      // and toolbar can paint the arming cue before microphone init begins.
      setArming: (target) =>
        set({
          activeTarget: target,
          status: "arming",
          lastError: null,
        }),

      beginSession: (target) =>
        set((state) => ({
          activeTarget: target,
          status: "connecting",
          lastError: null,
          elapsedSeconds: 0,
          panelBuffers: {
            ...state.panelBuffers,
            [target.panelId]: {
              ...getBuffer(state.panelBuffers, target.panelId),
              liveText: "",
              completedSegments: [],
              projectId: target.projectId,
              sessionDraftStart: -1,
              draftLengthAtSegmentStart: -1,
              activeParagraphStart: -1,
              transcriptPhase: "idle" as VoiceTranscriptPhase,
              correctionRange: null,
              sessionCorrectedText: null,
            },
          },
        })),

      setStatus: (status) => set({ status }),

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
                draftLengthAtSegmentStart: -1,
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
                draftLengthAtSegmentStart: -1,
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

      lockTarget: (target) => set({ lockedTarget: target }),

      unlockTarget: () => set({ lockedTarget: null }),

      clearLockedTarget: (panelId) =>
        set((state) => {
          if (state.lockedTarget?.panelId !== panelId) return state;
          return { lockedTarget: null };
        }),

      recordRecentTarget: (target) =>
        set((state) => {
          const entry: RecentDictationTarget = {
            panelId: target.panelId,
            panelTitle: target.panelTitle,
            projectId: target.projectId,
            projectName: target.projectName,
            worktreeId: target.worktreeId,
            worktreeLabel: target.worktreeLabel,
            lastUsedAt: Date.now(),
          };
          // Dedup by logical identity. Live entries (with panelId) collide on
          // panelId match; rehydrated entries (no panelId) collide on the
          // (worktreeId + panelTitle) tuple — which is how `liveRecentVoiceTargets`
          // resolves them back to a live panel after restart.
          const filtered = state.recentTargets.filter((t) => {
            if (t.panelId && t.panelId === target.panelId) return false;
            if (
              !t.panelId &&
              t.panelTitle &&
              t.panelTitle === target.panelTitle &&
              t.worktreeId === target.worktreeId
            ) {
              return false;
            }
            return true;
          });
          return {
            recentTargets: [entry, ...filtered].slice(0, MAX_RECENT_TARGETS),
          };
        }),
    }),
    {
      name: "daintree-voice-recording",
      // Debounced storage: high-frequency setters (`setAudioLevel` at RAF rate,
      // `setElapsedSeconds` per second) trigger persist writes regardless of
      // whether the partialized output changed. Coalescing to a trailing-edge
      // 300ms write avoids burning the localStorage write queue mid-session.
      storage: createDebouncedSafeJSONStorage<VoiceRecordingPersistedState>(300, {
        mergeOnWrite: mergeVoiceRecordingPersistedWrite,
      }),
      // No `migrate`: at v0 the persisted blob is a forward-compatible subset of
      // the current shape (only `recentTargets`), and a version-0 store never sees
      // a version mismatch — so an explicit no-op migration would only muddy the
      // inferred persisted type.
      version: 0,
      // Persist only the recent-targets list. Strip the live `panelId` on each
      // entry so a stale id cannot silently re-route dictation after restart —
      // panelIds are ephemeral. Lock state and session state are runtime-only.
      partialize: (state): VoiceRecordingPersistedState => ({
        recentTargets: state.recentTargets.map(({ panelId: _panelId, ...rest }) => rest),
      }),
    }
  )
);

registerPersistedStore({
  storeId: "voiceRecordingStore",
  store: useVoiceRecordingStore,
  persistedStateType: "{ recentTargets: RecentDictationTarget[] (panelId stripped) }",
});
