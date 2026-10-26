import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import {
  isActiveVoiceSession,
  type VoiceInputError,
  type VoiceInputStatus,
  type VoiceLiveSessionUpdate,
  type VoiceSessionElsewhere,
  type VoiceTranscriptPhase,
} from "@shared/types";
import { createDebouncedSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import type { VoiceMicDevice } from "@/services/voiceMicDevices";
import { VOICE_PARAGRAPH_BREAK } from "@/lib/voiceTranscriptSegments";
import type { RewriteSelection } from "@/services/voiceRewriteSelection";

/**
 * A session recording a spoken instruction for selected composer text
 * (#14635) rather than dictating into the draft.
 */
export interface VoiceRewriteRequest {
  selection: RewriteSelection;
  /** The instruction's finished segments, in order. */
  instruction: string[];
  /** Escape landed while it was finishing: drain, but don't send it. */
  cancelled: boolean;
}

export interface VoiceRecordingTarget {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
  /** Set when this session records a rewrite instruction instead of dictation. */
  rewrite?: VoiceRewriteRequest;
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
  // JSON-encode the key fields so a value containing the delimiter can't forge a
  // collision with a different target.
  if (target.worktreeId || target.panelTitle) {
    return `id:${JSON.stringify([target.worktreeId ?? "", target.panelTitle ?? ""])}`;
  }
  return `anon:${JSON.stringify([
    target.projectId ?? "",
    target.projectName ?? "",
    target.worktreeLabel ?? "",
    target.lastUsedAt,
  ])}`;
}

/**
 * Index a recent-targets list by logical identity, keeping the more-recently-used
 * entry when one list holds two entries with the same identity.
 */
function toTargetsByIdentity(
  value: StorageValue<VoiceRecordingPersistedState> | null
): Record<string, RecentDictationTarget> {
  const byIdentity: Record<string, RecentDictationTarget> = {};
  for (const target of toRecentTargets(value)) {
    const identity = recentTargetIdentity(target);
    const existing = byIdentity[identity];
    if (!existing || target.lastUsedAt > existing.lastUsedAt) byIdentity[identity] = target;
  }
  return byIdentity;
}

/**
 * Baseline-aware three-way merge for voice-recording writes across project views
 * (issue #11351). `recentTargets` is one global MRU list (cap 3) that any view
 * appends to, and the store's high-frequency transient setters (`setAudioLevel`,
 * `setElapsedSeconds`) trigger debounced persist writes of it — so a stale view's
 * flush would otherwise drop a sibling's just-recorded target.
 *
 * All three inputs are keyed by logical identity and reconciled with the same
 * writer-delta semantics the other stores use: an entry this writer added or
 * changed wins, one it left untouched defers to disk, and one that was in its
 * baseline but is gone from its snapshot is dropped. That last case is what a
 * plain union gets wrong: `recordRecentTarget` dedupes in memory by `panelId`,
 * but a persisted entry's identity is `(worktreeId, panelTitle)` — so re-dictating
 * into a panel whose title changed mid-session supersedes the old entry in memory,
 * and without the baseline the stale title would linger on disk forever, evicting
 * genuinely distinct targets through the cap. On a same-identity collision the
 * more-recently-used copy still wins, so a sibling's fresher timestamp is never
 * rolled back. The result is re-sorted and capped to the globally three
 * most-recent — the same recency semantics `recordRecentTarget` applies in a
 * single view.
 */
function mergeVoiceRecordingPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<VoiceRecordingPersistedState>): StorageValue<VoiceRecordingPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const disk = toTargetsByIdentity(onDisk);
  const merged = mergeRecordByWriterDelta(
    toTargetsByIdentity(baseline),
    toTargetsByIdentity(incoming),
    disk
  );
  const recentTargets = Object.entries(merged)
    .map(([identity, target]) => {
      const diskTarget = disk[identity];
      return diskTarget && diskTarget.lastUsedAt > target.lastUsedAt ? diskTarget : target;
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECENT_TARGETS);
  return { version: incoming.version, state: { recentTargets } };
}

interface VoiceLiveItem {
  itemId: string;
  text: string;
}

/**
 * Joins per-item interim text into the single ghost preview. Items are kept in
 * first-delta order; a space is inserted only where neither side already
 * carries whitespace, so a lone item renders exactly as its raw deltas.
 */
function joinLiveItems(items: VoiceLiveItem[]): string {
  let joined = "";
  for (const { text } of items) {
    if (!text) continue;
    joined += joined && !/\s$/.test(joined) && !/^\s/.test(text) ? ` ${text}` : text;
  }
  return joined;
}

export interface VoiceCorrectionRange {
  from: number;
  to: number;
}

// Shared empty value, so an idle buffer's ranges keep one identity.
const NO_CORRECTION_RANGES: VoiceCorrectionRange[] = [];

function sameCorrectionRanges(a: VoiceCorrectionRange[], b: VoiceCorrectionRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i]!.from && r.to === b[i]!.to);
}

interface VoiceTranscriptBuffer {
  liveText: string;
  /**
   * Interim text per identified item (OpenAI `item_id`), in first-delta order.
   * When non-empty, `liveText` is derived from it so one item's completion
   * retires only its own preview. Unidentified deltas bypass it.
   */
  liveItems: VoiceLiveItem[];
  /**
   * The session's committed text so far, in order, with a
   * {@link VOICE_PARAGRAPH_BREAK} entry where each paragraph ended. Reset when
   * a session begins and read once by `consumeCompletedSegments` when it stops.
   */
  completedSegments: string[];
  projectId?: string;
  /** Where the session's first dictated words start in the draft (-1 = none yet). */
  sessionDraftStart: number;
  /** Draft length at the start of the current paragraph (-1 = not set). */
  activeParagraphStart: number;
  /** Explicit transcript lifecycle phase — derived from and updated alongside buffer state. */
  transcriptPhase: VoiceTranscriptPhase;
  /**
   * Draft ranges currently undergoing the post-stop AI cleanup pass, one per
   * dictated passage (empty = none). Drives the `cm-voice-pending-ai` editor
   * decoration.
   */
  correctionRanges: VoiceCorrectionRange[];
  /**
   * The dictated text as it settled after the post-stop processing pass (AI
   * correction if enabled, else the raw transcription). Diffed against the
   * user's final edits at send time to learn dictionary words. Runtime-only,
   * ephemeral per session, never persisted — see [[#9514]] separate durable vs
   * in-session state.
   */
  sessionCorrectedText: string | null;
  /**
   * Identity of the session that last opened this buffer: the id main knows
   * it by, when it has one. Ties the text the session writes to its dictation
   * range (`dictationRangeStore`), so results main sends after the session
   * moves on still find that text.
   */
  dictationSessionId: string | null;
}

/**
 * What the microphone is actually delivering, independent of the transcription
 * backend's `status`. Bluetooth mics (AirPods switching A2DP→HFP) hand Web Audio
 * zeros for a while after `getUserMedia` resolves, so an open stream is not
 * proof of capture (#13105).
 *
 * - pending: stream open (or opening), no real samples seen yet.
 * - live: a PCM chunk above the noise floor has arrived; latched for the session.
 * - silent: still no real samples after the grace window.
 */
export type VoiceMicSignal = "pending" | "live" | "silent";

/**
 * A microphone event the pane that was dictating has to explain (#14606),
 * scoped to that target. Device labels are shown here and never logged.
 *
 * - lost: the input device went away; the session was ended and its text kept.
 * - fallback: the chosen device wasn't there at start, so another mic is in use.
 * - silent: the mic is still delivering silence after the grace window.
 *   `builtIn` is the mic to switch to, when one other than this one is found.
 */
export type VoiceMicNotice =
  | { kind: "lost"; target: VoiceRecordingTarget; deviceLabel: string | null }
  | { kind: "fallback"; target: VoiceRecordingTarget; deviceLabel: string | null }
  | {
      kind: "silent";
      target: VoiceRecordingTarget;
      deviceLabel: string | null;
      bluetooth: boolean;
      builtIn: VoiceMicDevice | null;
    };

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
  /** Panel the last error ended a session in; the error mark belongs to that panel only. */
  errorPanelId: string | null;
  /** True in the last seconds of a pause, before it auto-stops the session. */
  pauseStopWarning: boolean;
  activeTarget: VoiceRecordingTarget | null;
  /**
   * Where the next session will record, from the press until it begins. A
   * start can wait behind a session that is still finishing, and that
   * session's late transcripts keep routing by `activeTarget`, so the arming
   * cue reads this field instead.
   */
  pendingTarget: VoiceRecordingTarget | null;
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
  /**
   * A session live in another view, as main last reported it. The dictation
   * key stops it instead of starting one here, and the toolbar says where it
   * runs. Runtime-only.
   */
  sessionElsewhere: VoiceSessionElsewhere | null;
  sessionElsewhereRevision: number;
  elapsedSeconds: number;
  audioLevel: number;
  micSignal: VoiceMicSignal;
  /** Label of the mic the current session captures from; null when unknown or idle. */
  micDeviceLabel: string | null;
  micNotice: VoiceMicNotice | null;
  panelBuffers: Record<string, VoiceTranscriptBuffer>;
  announcement: VoiceAnnouncement | null;
  setConfigured: (isConfigured: boolean) => void;
  setCorrectionEnabled: (enabled: boolean) => void;
  setLearnFromCorrections: (enabled: boolean) => void;
  setSessionCorrectedText: (panelId: string, text: string | null) => void;
  setAudioLevel: (level: number) => void;
  setMicSignal: (signal: VoiceMicSignal) => void;
  setMicDeviceLabel: (label: string | null) => void;
  setMicNotice: (notice: VoiceMicNotice | null) => void;
  /** Clears the notice only if it is still `notice`, so a newer one survives a stale dismiss. */
  dismissMicNotice: (notice: VoiceMicNotice) => void;
  setArming: (target: VoiceRecordingTarget) => void;
  clearPendingTarget: () => void;
  beginSession: (target: VoiceRecordingTarget, sessionId?: string) => void;
  setStatus: (status: VoiceInputStatus) => void;
  setLastError: (error: VoiceInputError | null) => void;
  setPauseStopWarning: (warning: boolean) => void;
  setErrorPanelId: (panelId: string | null) => void;
  setElapsedSeconds: (seconds: number) => void;
  /** `replace` sets the preview to `delta` instead of appending (a revised hypothesis). */
  appendDelta: (delta: string, itemId?: string, replace?: boolean) => void;
  setSessionDraftStart: (panelId: string, length: number) => void;
  /**
   * `discard` retires the utterance without keeping its words: a spoken
   * command that acts on the draft rather than adding to it.
   */
  completeSegment: (text: string, itemId?: string, options?: { discard?: boolean }) => void;
  setCorrectionRanges: (panelId: string, ranges: VoiceCorrectionRange[]) => void;
  /**
   * Moves the panel's draft offsets at or after `at` by `delta`, for an edit
   * the voice service made earlier in the draft (a correction landing while a
   * new session dictates after it).
   */
  shiftDraftOffsets: (panelId: string, at: number, delta: number) => void;
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
  /** Applies main's report of the live session unless a newer one already landed. */
  applyLiveSessionUpdate: (update: VoiceLiveSessionUpdate) => void;
}

function getBuffer(
  panelBuffers: Record<string, VoiceTranscriptBuffer>,
  panelId: string
): VoiceTranscriptBuffer {
  return (
    panelBuffers[panelId] ?? {
      liveText: "",
      liveItems: [],
      completedSegments: [],
      sessionDraftStart: -1,
      activeParagraphStart: -1,
      transcriptPhase: "idle" as VoiceTranscriptPhase,
      correctionRanges: NO_CORRECTION_RANGES,
      sessionCorrectedText: null,
      dictationSessionId: null,
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
      errorPanelId: null,
      pauseStopWarning: false,
      activeTarget: null,
      pendingTarget: null,
      lockedTarget: null,
      recentTargets: [],
      sessionElsewhere: null,
      sessionElsewhereRevision: -1,
      elapsedSeconds: 0,
      audioLevel: 0,
      micSignal: "pending",
      micDeviceLabel: null,
      micNotice: null,
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

      setPauseStopWarning: (pauseStopWarning) => set({ pauseStopWarning }),

      setErrorPanelId: (errorPanelId) => set({ errorPanelId }),

      setAudioLevel: (audioLevel) => set({ audioLevel }),

      setMicSignal: (micSignal) => set({ micSignal }),

      setMicDeviceLabel: (micDeviceLabel) => set({ micDeviceLabel }),

      setMicNotice: (micNotice) => set({ micNotice }),

      dismissMicNotice: (notice) =>
        set((state) => (state.micNotice === notice ? { micNotice: null } : state)),

      // Atomic single-set transition into the pre-audio confirmation phase.
      // Fires synchronously before any await in start() so the target panel
      // and toolbar can paint the arming cue before microphone init begins.
      // A session still running or finishing keeps its target and status: its
      // remaining transcripts belong to its own panel (#14604).
      setArming: (target) =>
        set((state) =>
          isActiveVoiceSession(state.status)
            ? { pendingTarget: target, lastError: null, errorPanelId: null }
            : {
                activeTarget: target,
                pendingTarget: target,
                status: "arming",
                lastError: null,
                errorPanelId: null,
                micSignal: "pending",
                micDeviceLabel: null,
                micNotice: null,
              }
        ),

      clearPendingTarget: () =>
        set((state) => (state.pendingTarget === null ? state : { pendingTarget: null })),

      beginSession: (target, sessionId) =>
        set((state) => ({
          activeTarget: target,
          pendingTarget: null,
          status: "connecting",
          lastError: null,
          errorPanelId: null,
          elapsedSeconds: 0,
          micSignal: "pending",
          micDeviceLabel: null,
          micNotice: null,
          panelBuffers: {
            ...state.panelBuffers,
            [target.panelId]: {
              ...getBuffer(state.panelBuffers, target.panelId),
              liveText: "",
              liveItems: [],
              completedSegments: [],
              projectId: target.projectId,
              sessionDraftStart: -1,
              activeParagraphStart: -1,
              transcriptPhase: "idle" as VoiceTranscriptPhase,
              correctionRanges: NO_CORRECTION_RANGES,
              sessionCorrectedText: null,
              dictationSessionId: sessionId ?? crypto.randomUUID(),
            },
          },
        })),

      setStatus: (status) => set({ status }),

      setElapsedSeconds: (elapsedSeconds) => set({ elapsedSeconds }),

      appendDelta: (delta, itemId, replace) =>
        set((state) => {
          const panelId = state.activeTarget?.panelId;
          // An empty replacement is a retraction, so it still lands.
          if (!panelId || (!delta && !replace)) return state;
          const buffer = getBuffer(state.panelBuffers, panelId);
          if (itemId) {
            const index = buffer.liveItems.findIndex((item) => item.itemId === itemId);
            const liveItems =
              index >= 0
                ? buffer.liveItems.map((item, i) =>
                    i === index ? { itemId, text: replace ? delta : item.text + delta } : item
                  )
                : [...buffer.liveItems, { itemId, text: delta }];
            return {
              panelBuffers: {
                ...state.panelBuffers,
                [panelId]: {
                  ...buffer,
                  liveItems,
                  liveText: joinLiveItems(liveItems),
                  transcriptPhase: "interim" as VoiceTranscriptPhase,
                },
              },
            };
          }
          return {
            panelBuffers: {
              ...state.panelBuffers,
              [panelId]: {
                ...buffer,
                liveText: replace ? delta : buffer.liveText + delta,
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

      completeSegment: (text, itemId, options) =>
        set((state) => {
          const panelId = state.activeTarget?.panelId;
          if (!panelId) return state;

          const buffer = getBuffer(state.panelBuffers, panelId);
          if (itemId) {
            // Retire only this item's preview; other items still streaming keep
            // theirs. The completion text is authoritative — an empty final
            // never falls back to the item's interim deltas.
            const liveItems = buffer.liveItems.filter((item) => item.itemId !== itemId);
            const liveText = joinLiveItems(liveItems);
            const finalText = text.trim();
            return {
              panelBuffers: {
                ...state.panelBuffers,
                [panelId]: {
                  ...buffer,
                  liveItems,
                  liveText,
                  // Any legacy anchor from an unidentified delta is consumed here;
                  // leaving it would let a later stop flush slice at a stale offset.
                  completedSegments: finalText
                    ? [...buffer.completedSegments, finalText]
                    : buffer.completedSegments,
                  transcriptPhase: (liveText
                    ? "interim"
                    : finalText
                      ? "utterance_final"
                      : "idle") as VoiceTranscriptPhase,
                },
              },
            };
          }
          const normalized = options?.discard ? "" : text.trim() || buffer.liveText.trim();
          if (!normalized) {
            return {
              panelBuffers: {
                ...state.panelBuffers,
                [panelId]: {
                  ...buffer,
                  liveText: "",
                  liveItems: [],
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
                liveItems: [],
                completedSegments: [...buffer.completedSegments, normalized],
                transcriptPhase: "utterance_final" as VoiceTranscriptPhase,
              },
            },
          };
        }),

      setCorrectionRanges: (panelId, ranges) =>
        set((state) => {
          const buffer = getBuffer(state.panelBuffers, panelId);
          if (sameCorrectionRanges(buffer.correctionRanges, ranges)) return state;
          return {
            panelBuffers: {
              ...state.panelBuffers,
              [panelId]: {
                ...buffer,
                correctionRanges: ranges.length > 0 ? ranges : NO_CORRECTION_RANGES,
              },
            },
          };
        }),

      shiftDraftOffsets: (panelId, at, delta) =>
        set((state) => {
          const buffer = state.panelBuffers[panelId];
          if (!buffer || delta === 0) return state;
          const shift = (offset: number) => (offset >= 0 && offset >= at ? offset + delta : offset);
          return {
            panelBuffers: {
              ...state.panelBuffers,
              [panelId]: {
                ...buffer,
                sessionDraftStart: shift(buffer.sessionDraftStart),
                activeParagraphStart: shift(buffer.activeParagraphStart),
              },
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
                // Identified items still streaming belong to later segments —
                // a paragraph break inside an earlier item must not erase them.
                liveText: joinLiveItems(buffer.liveItems),
                // The session keeps its earlier paragraphs for the history
                // (#14637); "new paragraph" arrives as two breaks in a row.
                completedSegments:
                  buffer.completedSegments.length > 0
                    ? [...buffer.completedSegments, VOICE_PARAGRAPH_BREAK]
                    : buffer.completedSegments,
                activeParagraphStart: -1,
                transcriptPhase: (buffer.liveItems.some((item) => item.text)
                  ? "interim"
                  : "idle") as VoiceTranscriptPhase,
              },
            },
          };
        }),

      finishSession: ({ nextStatus = "idle", preserveLiveText = false } = {}) =>
        set((state) => {
          const panelId = state.activeTarget?.panelId;
          // A silent warning belongs to the session that was silent; the other
          // notices outlive it until dismissed or the next session starts.
          const micNotice = state.micNotice?.kind === "silent" ? null : state.micNotice;
          const errorPanelId = nextStatus === "error" ? (panelId ?? null) : null;
          if (!panelId) {
            return {
              activeTarget: null,
              errorPanelId,
              status: nextStatus,
              elapsedSeconds: 0,
              audioLevel: 0,
              micSignal: "pending" as VoiceMicSignal,
              micDeviceLabel: null,
              micNotice,
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
            errorPanelId,
            status: nextStatus,
            elapsedSeconds: 0,
            audioLevel: 0,
            micSignal: "pending" as VoiceMicSignal,
            micDeviceLabel: null,
            micNotice,
            panelBuffers: {
              ...state.panelBuffers,
              [panelId]: {
                ...buffer,
                liveText: "",
                liveItems: [],
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

      applyLiveSessionUpdate: ({ revision, session }) =>
        set((state) => {
          if (revision < state.sessionElsewhereRevision) return state;
          return { sessionElsewhere: session, sessionElsewhereRevision: revision };
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

/** The mic notice for one pane: a notice is only ever shown where it happened. */
export function selectMicNoticeForPanel(
  state: { micNotice: VoiceMicNotice | null },
  panelId: string | null | undefined
): VoiceMicNotice | null {
  return panelId && state.micNotice?.target.panelId === panelId ? state.micNotice : null;
}

/**
 * True while a session is open but the mic hasn't delivered real audio yet —
 * the window in which the UI must not claim it is listening. Independent of
 * whether the transcription backend is still connecting.
 */
export function isVoiceMicPending(state: {
  status: VoiceInputStatus;
  micSignal: VoiceMicSignal;
}): boolean {
  return (
    (state.status === "connecting" ||
      state.status === "recording" ||
      state.status === "reconnecting") &&
    state.micSignal !== "live"
  );
}

registerPersistedStore({
  storeId: "voiceRecordingStore",
  store: useVoiceRecordingStore,
  persistedStateType: "{ recentTargets: RecentDictationTarget[] (panelId stripped) }",
});
