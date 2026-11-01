import { useProjectStore } from "@/store/projectStore";
import { scratchName, useScratchStore } from "@/store/scratchStore";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { usePanelStore } from "@/store/panelStore";
import {
  cleanupKeyIssuer,
  hasCleanupKey,
  hasTranscriptionKey,
} from "@shared/config/voiceProviders";
import {
  carrySpansThroughEdits,
  shiftSpans,
  sliceSpans,
  type VoiceTextEdit,
} from "@shared/utils/voiceUncertainWords";
import {
  carryPausePositionsThroughEdits,
  normalizePausePositions,
  shiftPausePositions,
  slicePausePositions,
} from "@shared/utils/voicePausePositions";
import { panelHasComposer } from "@/components/Terminal/terminalComposer";
import { shouldShowHybridInputBar } from "@/components/Terminal/terminalFocus";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isPtyPanel } from "@shared/types/panel";
import { wasAssistantUsedAfter } from "@/lib/composerSurface";
import { useFocusStore } from "@/store/focusStore";
import { useHelpPanelStore, selectActiveSlot, selectSlotTerminalIds } from "@/store/helpPanelStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  dictatedSpans,
  useDictationRangeStore,
  type DictatedSpan,
  type DictationDraftTarget,
  type DictationRecord,
  type DictationUtterance,
  type DictationTextSpan,
} from "@/store/dictationRangeStore";
import { minimalDocChange, type TextChange, type TrackedTextRange } from "@/lib/textRangeMapping";
import {
  peekPendingComposerSelection,
  readComposerSelection,
  setPendingComposerSelection,
} from "@/lib/composerCaret";
import { makeDraftKey } from "@/lib/draftKey";
import { correctionRequest } from "@/services/voiceCorrectionRequest";
import {
  planVoiceBreak,
  planVoiceWords,
  voiceWordsOpenDraft,
  type VoiceInsertPlan,
} from "./voiceInsertion";
import {
  isVoiceMicPending,
  useVoiceRecordingStore,
  type VoiceCorrectionRange,
  type VoiceMicNotice,
  type VoiceRecordingTarget,
  type VoiceRewriteRequest,
  type VoiceScratchRefusal,
} from "@/store/voiceRecordingStore";
import { keepRecentDictation, keepRecentDictationCorrection } from "@/services/recentDictations";
import {
  getLeaseInputBlock,
  subscribeTerminalInputGate,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import { joinCompletedSegments } from "@/lib/voiceTranscriptSegments";
import { startVoiceDetailsPublisher } from "@/services/voiceSessionDetailsPublisher";
import { setElsewhereLevel } from "@/services/voiceElsewhereLevel";
import {
  isActiveVoiceSession,
  VOICE_REPLAY_AUDIO_LOST_CODE,
  VOICE_STOP_AUDIO_LOST_CODE,
  type VoiceCleanupFailure,
  type VoiceCorrectionModel,
  type VoiceInputStatus,
  type VoiceRecordingMode,
  type VoiceSessionElsewhere,
  type VoiceTranscriptionProvider,
} from "@shared/types";
import {
  TRANSCRIPTION_ITEM_FAILED_CODE,
  VOICE_WORKSPACE_NAME_MAX_LENGTH,
} from "@shared/types/voice";
import type { HostId } from "@shared/types/remoteHosts";
import type { VoiceCorrectionVerdict, VoiceStopReason } from "@shared/types/voiceSessionSummary";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { registerEscapeFallback } from "@/lib/escapeStack";
import { DICTATION_CANCEL_CONFIRM_PROMPT, PRESS_AGAIN_CONFIRM_MS } from "@/lib/pressAgain";
import { useCanopyStore } from "@/store/canopyStore";
import {
  isCanopyReplyTarget,
  resolveCanopyReplyDictation,
  voiceContext,
  type VoiceContext,
} from "@/services/canopyReplyDictation";
import { keybindingService } from "@/services/KeybindingService";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { notify } from "@/lib/notify";
import type { NotificationAction } from "@/store/notificationStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { isProjectHomePresented } from "@/store/storeAccessors";
import { getClosingIds } from "@/services/terminal/optimisticPanelCloseIds";
import { buildFleetPanels } from "@/components/Terminal/contentGridFleetPanels";
import { listVisiblePaneIds, pickRecentVisibleTarget } from "@/services/voiceFallbackTarget";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  OPENING_CHUNK_WINDOW,
  hasRealSignal,
  isMicLive,
  isSpeechLevel,
  measurePcm16Chunk,
  summarizeOpeningChunks,
  type PcmChunkStats,
} from "@/services/voiceStartDiagnostics";
import {
  recordCorrectionLanded,
  writeComposerDraftThrough,
  type CorrectionBaseline,
  type LandedCorrection,
} from "@/services/voiceCorrectionLanding";
import { chunkFollowUpDecides, mayCutChunk } from "@/services/voiceCleanupChunks";
import { CorrectionStreamAligner, type StreamedRewrite } from "@/services/voiceCorrectionStream";
import {
  isHeldBackSession,
  planVoiceDraftSend,
  sendWaitingStopAndSends,
  type VoiceDraftSend,
} from "@/services/voiceDraftSend";
import {
  logVoiceSendRefused,
  type VoiceSendAsker,
  type VoiceSendRefusal,
  type VoiceStopAndSendAsker,
} from "@/services/voiceSendDiagnostics";
import {
  collectCorrectionPassages,
  countPassageFates,
  joinPassageTexts,
  locatePassage,
  settlePassageReplies,
  transcribedPassage,
  type CorrectionPassage,
  type PassageFate,
} from "@/services/voiceCorrectionPassages";
import {
  collectHeardAsRules,
  createHeardAsRewriter,
  type HeardAsRewriter,
} from "@shared/utils/voiceHeardAs";
import { stripHesitations } from "@shared/utils/voiceHesitations";
import { normalizeVoiceLanguage } from "@shared/config/voiceLanguages";
import {
  findBuiltInMic,
  isBluetoothMicLabel,
  isMicPermissionDenial,
  openChosenMic,
  stripPseudoDevicePrefix,
  type OpenedMic,
  type VoiceMicDevice,
} from "@/services/voiceMicDevices";
import {
  isScratchCommand,
  recordScratchLanded,
  SCRATCH_REFUSAL_STATUS,
} from "@/services/voiceScratchCommand";
import {
  planFileReferenceEdits,
  planHeardSwaps,
  type SpokenFileReference,
  unresolvedFileReferencesStatus,
} from "@/services/voiceFileReferences";
import { isSpokenSendable } from "@/services/voiceSpokenSend";
import { findRewriteComposer, type RewriteSelection } from "@/services/voiceRewriteSelection";
import {
  beginDictationReturn,
  focusDictationComposer,
  overlayHoldsKeyboard,
  revealAssistantComposer,
  revealDictationComposer,
} from "@/services/voiceComposerFocus";
import { captureFocusEpoch, isFocusEpochCurrent } from "@/components/Terminal/paneFocusRequest";
import {
  isSameHost,
  namesSessionHost,
  sessionHostName,
  sessionPlacePhrase,
  sessionWorkspaceName,
} from "@/services/voiceSessionPlace";
import { currentHostId } from "@/hooks/useHostPlatform";
import { getHostListSnapshot } from "@/components/Hosts/hostList";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import {
  cleanupReasoningEffortFor,
  VOICE_CLEANUP_AI_MODEL,
  VOICE_REWRITE_MAX_INSTRUCTION_CHARS,
  VOICE_REWRITE_MAX_SELECTION_CHARS,
} from "@shared/config/voiceCorrection";
import type { VoiceRewriteOutcome } from "@shared/types/voice";
import { VoiceSessionTimeline, type VoiceCorrectionOutcome } from "@/services/voiceSessionTimeline";
import { estimateCorrectionMs, recordCorrectionPace } from "@/services/voiceCorrectionPace";

const LOG_PREFIX = "[VoiceRecording]";

/** A chunk passage's fates that leave its words for a later pass to clean (#14932). */
const CLEANED_AGAIN: ReadonlySet<PassageFate> = new Set<PassageFate>([
  "failed",
  "timed_out",
  "unlanded",
]);
// How long a cached view the indicator asked for waits to come on screen
// before it gives up on putting the keyboard in its pane.
const REVEAL_FOCUS_WAIT_MS = 15_000;

// What this view calls its workspace, for views on other hosts to name it by:
// this machine has no name for a host's project or scratch (#14773).
function viewWorkspaceName(): string | undefined {
  const workspaceId = getViewWorkspaceId();
  const name =
    workspaceId && isScratchWorkspaceId(workspaceId)
      ? scratchName(useScratchStore.getState().scratches, workspaceId)
      : useProjectStore.getState().currentProject?.name;
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, VOICE_WORKSPACE_NAME_MAX_LENGTH) : undefined;
}
const REPLACED_ELSEWHERE_ANNOUNCEMENT =
  "Dictation stopped because it started in another window or project.";

const spokenSendKey = (panelId: string, projectId: string | undefined) =>
  `${projectId ?? ""}\0${panelId}`;

type StartStepLogger = (step: string, details?: Record<string, unknown>) => void;

/** How a composer's send was asked for: a spoken "send it" holds back a too-short draft. */
export interface VoiceSendOptions {
  spoken?: boolean;
  /** What asked, for the line a refused send leaves. Left out, it follows `spoken`. */
  asker?: VoiceSendAsker;
  /** A spoken "send it" its draft was too short for: nothing is sent, and the composer says so. */
  tooShort?: boolean;
}

/** The running session's clock, as {@link VoiceRecordingService.getSessionClock} reads it. */
export interface VoiceSessionClock {
  /** The provider the session started on. */
  provider: VoiceTranscriptionProvider | null;
  /** Wall time since the session began, pauses included. */
  elapsedMs: number;
  /** How much of that was paused, the pause under way included. */
  pausedMs: number;
  /** The auto-stop that ends the session next, and how far off it is. */
  autoStop: { reason: "pause" | "idle"; remainingMs: number } | null;
}

interface OpeningAudio {
  startRequestId: number;
  chunks: PcmChunkStats[];
  logged: boolean;
}

function formatTargetLabel(target: VoiceRecordingTarget): string {
  const project = target.projectName?.trim();
  const worktree = target.worktreeLabel?.trim();
  const title = target.panelTitle?.trim();

  if (title) return title;
  if (project && worktree) {
    return `${project} / ${worktree}`;
  }
  if (project) return project;
  if (worktree) return worktree;
  return "current panel";
}

function cleanupFailureMessage({ reason, provider }: VoiceCleanupFailure): string {
  const issuer = cleanupKeyIssuer(provider);
  const kept = "so dictation is kept as you said it.";
  switch (reason) {
    case "key_rejected":
      return `${issuer} rejected the API key, ${kept} Update the key in voice settings.`;
    case "billing_required":
      return `The ${issuer} account is out of credit or at its spending limit, ${kept} Add credit, raise the limit, or use a key from another account.`;
    case "region_refused":
      return `${issuer} isn't available in your region, ${kept} Choose another cleanup provider in voice settings.`;
    case "access_denied":
      return `The cleanup model isn't available to this ${issuer} key, ${kept} Check the key's access or choose another model in voice settings.`;
  }
}

/**
 * Where the session's next words go in this draft: its anchor, or else the
 * caret (or the selection) the composer last showed in this exact draft, or
 * else the end. Without a session nothing is tracked and the words append.
 * While a send from the draft waits on its cleanup, the caret sits in text
 * that is about to go, so a session that send doesn't take writes after it
 * (#14804).
 */
function resolveVoiceAnchor(
  panelId: string,
  projectId: string | undefined,
  sessionId: string | null | undefined,
  draft: string
): TrackedTextRange | null {
  if (!sessionId) return null;
  const target = { sessionId, panelId, projectId };
  const store = useDictationRangeStore.getState();
  const existing = store.getAnchor(target);
  if (existing) return existing;
  const caret = isHeldBackSession(panelId, sessionId)
    ? null
    : readComposerSelection(makeDraftKey(panelId, projectId), draft);
  store.setAnchor(target, caret ?? { from: draft.length, to: draft.length });
  return useDictationRangeStore.getState().getAnchor(target);
}

/**
 * Writes one voice plan into the draft and records it: the range store maps
 * the session's earlier text through the write first, then takes the new
 * span, and the anchor moves to just after what was written.
 */
function commitVoicePlan(
  panelId: string,
  projectId: string | undefined,
  sessionId: string | null | undefined,
  plan: VoiceInsertPlan,
  record: (target: DictationDraftTarget, plan: VoiceInsertPlan) => void
): void {
  const inputStore = useTerminalInputStore.getState();
  const draftKey = makeDraftKey(panelId, projectId);
  const draft = inputStore.getDraftInput(panelId, projectId);
  // A caret sitting where the words go follows them; one anywhere else stays
  // where the user left it. Until the composer has caught up with an earlier
  // write, its caret is the one that write asked for: the sync takes the hint,
  // so one still waiting is newer than anything the composer showed.
  const caret =
    peekPendingComposerSelection(draftKey, draft) ?? readComposerSelection(draftKey, draft);
  if (caret && caret.from === plan.at.from && caret.to === plan.at.to) {
    setPendingComposerSelection(draftKey, plan.next, plan.anchor);
  }
  useDictationRangeStore
    .getState()
    .expectDraftChange(panelId, projectId, draft, plan.next, plan.change);
  inputStore.setDraftInput(panelId, plan.next, projectId);
  if (sessionId) {
    const target = { sessionId, panelId, projectId };
    record(target, plan);
    useDictationRangeStore.getState().setAnchor(target, plan.anchor);
  }
  inputStore.bumpExternalDraftRevision({ keepsSelection: true });
}

/**
 * Drops the anchors of the session about to finish. Its records stay, so
 * correction and late file references still find its text; anything it writes
 * after this would need a new session anyway.
 */
function releaseActiveVoiceAnchors(): void {
  const { activeTarget, panelBuffers } = useVoiceRecordingStore.getState();
  const sessionId = activeTarget ? panelBuffers[activeTarget.panelId]?.dictationSessionId : null;
  if (sessionId) useDictationRangeStore.getState().releaseAnchors(sessionId);
}

/** Whether words dictated now would open the prompt, wherever the caret put them. */
function voiceWordsOpenPrompt(
  panelId: string,
  projectId: string | undefined,
  sessionId: string | null | undefined
): boolean {
  const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
  return voiceWordsOpenDraft(draft, resolveVoiceAnchor(panelId, projectId, sessionId, draft));
}

/** Writes dictated words at the session's anchor; returns where they landed. */
function writeVoiceWords(
  panelId: string,
  projectId: string | undefined,
  sessionId: string | null | undefined,
  text: string,
  transcriptId?: string,
  heard?: string,
  uncertain?: { text: DictationTextSpan[]; heard?: DictationTextSpan[] },
  pauses?: { text: number[]; heard: number[] }
): VoiceInsertPlan {
  const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
  const plan = planVoiceWords(
    draft,
    resolveVoiceAnchor(panelId, projectId, sessionId, draft),
    text
  );
  commitVoicePlan(
    panelId,
    projectId,
    sessionId,
    plan,
    (target, { insertion, words, separatorAfter, replaced }) =>
      useDictationRangeStore.getState().recordUtterance(target, {
        insertion,
        words,
        separatorAfter,
        transcriptId,
        heard,
        uncertain: uncertain?.text,
        heardUncertain: uncertain?.heard,
        pauses: pauses?.text,
        heardPauses: pauses?.heard,
        replaced,
      })
  );
  return plan;
}

// ~15s of 100ms PCM chunks, held only until the backend start is requested
// (a retarget drain can take that long); past it the oldest audio is dropped
// rather than failing the session.
const MAX_QUEUED_CHUNKS = 150;

// How long a stop waits for the worklet to hand over its partial chunk. Port
// messages are answered within a render quantum, even while the context is
// suspended, so this only guards a worklet that can no longer reply.
const WORKLET_FLUSH_TIMEOUT_MS = 250;

// How long the capture context stays warm after the last dictation ends, so a
// dictation soon after reuses it instead of rebuilding the graph (#14618).
const WARM_AUDIO_IDLE_MS = 5 * 60_000;

// lib.dom's AudioContextOptions predates `sinkId` (Chromium 110+).
type CaptureContextOptions = AudioContextOptions & { sinkId?: string | { type: "none" } };

/**
 * The capture AudioContext, kept across dictations with its worklet module
 * loaded. Only the microphone and the nodes on it belong to each capture, so
 * the mic still closes at stop. Suspended while no capture uses it, and closed
 * after WARM_AUDIO_IDLE_MS of that.
 */
interface WarmAudio {
  context: AudioContext;
  // "none" renders without opening an output device; "default" is the fallback
  // when that sink isn't available, and holds the output open while running.
  sink: "none" | "default";
  keepAliveOscillator: OscillatorNode | null;
  keepAliveGain: GainNode | null;
  workletReady: Promise<void> | null;
  users: Set<CaptureAttempt>;
  // Resume and suspend run in call order, so a release's suspend can never
  // land after the next start's resume.
  transition: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // Closed once its last capture lets go, instead of parked.
  retired: boolean;
}

/**
 * One pass of a dictation's AI cleanup, still on its way: a chunk sent while
 * the session ran (#14772), the pass at stop over whatever came after the
 * last one, or a pass after the stop over what a chunk couldn't land (#14932).
 */
interface PendingCorrection {
  kind: "chunk" | "stop" | "retry";
  /** The dictation's cleanup as a whole, which this pass is part of. */
  cleanup: DictationCleanup;
  panelId: string;
  projectId?: string;
  /** Taken as the pass was sent: a later session's target is not this one's. */
  context: VoiceContext;
  /** The dictation (`dictationRangeStore`) its passages belong to. */
  dictationId: string;
  /** The session that heard them, whose cleanup context main read while it ran. */
  sessionId: string | null;
  /** Each passage as it was sent. */
  passages: CorrectionPassage[];
  /** Passages no edit has reached; one that's touched is dropped for good. */
  live: Set<CorrectionPassage>;
  /** What each passage's cleanup has streamed over it so far; drawn, never written. */
  rewrites: Map<CorrectionPassage, StreamedRewrite>;
  /** Applied or dropped; either way it will never touch the draft again. */
  done: boolean;
  /** Resolves when the correction is done. */
  settled: Promise<void>;
  settle: () => void;
  /**
   * The summary of the session that dictated the passages: the stop-time
   * pass's timing and fates, or a share of the chunks' passage counts.
   */
  timeline: VoiceSessionTimeline | null;
  /** Its replies are in, so it says itself how each passage ended. */
  replied: boolean;
  /** A chunk or retry whose passages the summary has counted. */
  counted: boolean;
  /** `performance.now()` when the request went out. */
  startedAt: number;
  /** How long this machine's corrections of passages this long have taken. */
  expectedMs: number;
}

/**
 * Everything one dictation's cleanup did, across its chunks and the pass at
 * stop, for what reads the dictation as a whole: recent dictations, which keep
 * the cleaned text only when every word went through cleanup, and the
 * learning baseline. Kept until the session has stopped and every pass has
 * its reply.
 */
interface DictationCleanup {
  sessionId: string;
  panelId: string;
  projectId?: string;
  /** Utterances a chunk took; later passes leave them alone. */
  claimed: Set<string>;
  /** Every pass, in the order sent. */
  passes: PendingCorrection[];
  /** Each passage's cleaned text once its reply is in; null where it stays as dictated. */
  results: Map<CorrectionPassage, string | null>;
  /** Chunk passages that couldn't land and gave their words back to a later pass. */
  released: Set<CorrectionPassage>;
  /** Passages whose request failed: their words never went through cleanup. */
  failed: Set<CorrectionPassage>;
  /** The heard-as rerun's rewrites of chunks, in draft order, for the transcript. */
  rewrites: PassageRewrite[];
  stopped: boolean;
  /**
   * A graceful stop sent its pass without the chunks' words, so a chunk
   * passage that can't land after it is cleaned in a pass of its own.
   */
  retriesAfterStop: boolean;
  /** The recent-dictations entry and every passage that covers its words, set at stop. */
  history: { id: string; passages: CorrectionPassage[] } | null;
  /**
   * The learning baseline written at stop, and where in it each passage still
   * on its way sits, so its cleaned text can take its place.
   */
  baseline: { text: string; spans: Map<CorrectionPassage, { from: number; to: number }> } | null;
}

type ScratchOutcome =
  { kind: "removed"; sources: number } | { kind: "refused"; reason: VoiceScratchRefusal["reason"] };

/** Where the live session may cut its next chunk, waiting on what's said after it. */
interface ChunkBreak {
  sessionId: string;
  /** The last utterance before the break. */
  utteranceId: string;
  /** A spoken paragraph break rather than a pause. */
  paragraph: boolean;
  /** What has been said since. */
  after: string;
}

/**
 * Where a dictated passage starting at `start` begins once the draft went from
 * `before` to `after`: moved by an edit before it (text typed at its start
 * stays outside it), unmoved by one inside or after it, and -1 when an edit
 * ran across its start.
 */
function mapLearningStart(before: string, after: string, start: number): number {
  const change = minimalDocChange(before, after);
  if (!change || (change.from >= start && change.to > start)) return start;
  if (change.to <= start) return start + change.insert.length - (change.to - change.from);
  return -1;
}

/** Non-overlapping edits to `draft` as the changes they make, each trimmed to what it alters. */
function draftChanges(
  draft: string,
  edits: ReadonlyArray<{ from: number; to: number; text: string }>
): TextChange[] {
  return edits.flatMap(({ from, to, text }) => {
    const change = minimalDocChange(draft.slice(from, to), text);
    return change
      ? [{ from: from + change.from, to: from + change.to, insert: change.insert }]
      : [];
  });
}

type DrivenElsewhere = Extract<TerminalInputBlock, { kind: "driven-elsewhere" }>;

/**
 * Another screen's control of the project a draft belongs to, which hands
 * that draft over to its driver: what is written here is never saved and is
 * replaced by the driver's own. A draft with no project (a Canopy reply) is
 * this view's alone.
 */
function drivenElsewhereFor(projectId: string | undefined): DrivenElsewhere | null {
  if (projectId === undefined) return null;
  const block = getLeaseInputBlock();
  if (block?.kind !== "driven-elsewhere") return null;
  return block.projectId === undefined || block.projectId === projectId ? block : null;
}

/** Who has control, named as the pane's read-only notice names them. */
function controllerName(block: DrivenElsewhere): string {
  return block.driverIsHostScreen ? `${block.driverName}'s own screen` : block.driverName;
}

/** A spoken rewrite of a composer selection, on its way to the model. */
interface PendingRewrite {
  panelId: string;
  projectId: string | undefined;
  selection: RewriteSelection;
  /** Landed or dropped; either way it will never touch the draft again. */
  done: boolean;
  settled: Promise<void>;
  settle: () => void;
}

/** Whether a dictation's draft went to another screen's driver: its words are kept, not written. */
function isDraftDetached(dictationSessionId: string | null | undefined): boolean {
  return (
    !!dictationSessionId &&
    useVoiceRecordingStore.getState().draftDetachedSessionId === dictationSessionId
  );
}

/** The text a session dictated into its target's draft, while the draft still holds it. */
function findDictation(
  target: VoiceRecordingTarget,
  sessionId: string | null
): DictationRecord | null {
  if (!sessionId) return null;
  return (
    useDictationRangeStore
      .getState()
      .listDictations(target.panelId, target.projectId)
      .find((record) => record.sessionId === sessionId) ?? null
  );
}

/**
 * Just after the words the session dictated into the target's draft, as it
 * stands now: where its next words go while it still runs, else the end of
 * what it wrote. Null when it wrote nothing.
 */
function afterDictatedWords(target: VoiceRecordingTarget, sessionId: string | null): number | null {
  const record = findDictation(target, sessionId);
  if (!record) return null;
  const { panelId, projectId } = target;
  const anchor = useDictationRangeStore
    .getState()
    .getAnchor({ sessionId: record.sessionId, panelId, projectId });
  return anchor ? anchor.to : record.range.to;
}

/** Whether cancelling takes something out: words that were the selection leave the text as it is. */
function changesDraft({ from, to, restore = "" }: DictatedSpan, draft: string): boolean {
  return draft.slice(from, to) !== restore;
}

/** The draft a cancel leaves, the spans undone last first as `cancelDictation` writes them. */
function draftAfterCancel(spans: DictatedSpan[], draft: string): string {
  let next = draft;
  for (const { from, to, restore = "" } of spans) {
    if (draft.slice(from, to) !== restore) next = next.slice(0, from) + restore + next.slice(to);
  }
  return next;
}

/**
 * Where `offset` ends up once each span is taken out, or swapped for the
 * selection it replaced; one inside a span goes to its start.
 */
function offsetAfterRemoving(offset: number, spans: DictatedSpan[]): number {
  let removed = 0;
  for (const { from, to, restore } of spans) {
    if (from >= offset) continue;
    removed += Math.min(offset, to) - from - (offset >= to ? (restore?.length ?? 0) : 0);
  }
  return offset - removed;
}

/**
 * Where the selection the dictation replaced is after a cancel puts it back,
 * unless the caret has left the dictation for somewhere of its own. A caret
 * collapsed at the start of a span is the user's: dictation leaves it after
 * its words, and typing ahead of them is what leaves it there. `applied` are
 * the spans that changed the draft, which the offsets follow.
 */
function restoredSelection(
  spans: DictatedSpan[],
  applied: DictatedSpan[],
  caret: { from: number; to: number } | null
): { from: number; to: number } | null {
  const replaced = spans.find((span) => span.restore);
  if (!replaced) return null;
  if (caret) {
    const collapsed = caret.from === caret.to;
    const onDictation = spans.some(
      (span) =>
        caret.from >= span.from && caret.to <= span.to && !(collapsed && caret.from === span.from)
    );
    if (!onDictation) return null;
  }
  const from = offsetAfterRemoving(replaced.from, applied);
  return { from, to: from + replaced.restore!.length };
}

/** A stopped session's words, read once from its buffer for the recent-dictations history. */
interface FinishedTranscript {
  id: string;
  rawText: string;
  target: VoiceRecordingTarget;
}

function takeFinishedTranscript(
  target: VoiceRecordingTarget,
  sessionId: string | null
): FinishedTranscript | null {
  const store = useVoiceRecordingStore.getState();
  // A session begun on the panel since owns its buffer now.
  if (!sessionId || store.panelBuffers[target.panelId]?.dictationSessionId !== sessionId) {
    return null;
  }
  const rawText = joinCompletedSegments(store.consumeCompletedSegments(target.panelId));
  return rawText ? { id: sessionId, rawText, target } : null;
}

/** Whether two renderings of a dictation hold the same words, whatever separates them. */
function sameDictatedWords(a: string, b: string): boolean {
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  return collapse(a) === collapse(b);
}

/** A passage the stop-time heard-as rules rewrote: what the draft held, then what they wrote. */
interface PassageRewrite {
  landed: string;
  rewritten: string;
}

/** The last place `words` read in `text` before `end`, whatever whitespace separates them. */
function lastIndexOfWords(
  text: string,
  words: string,
  end: number
): { from: number; to: number } | null {
  const target = words.replace(/\s+/g, "");
  if (!target) return null;
  let compact = "";
  const offsets: number[] = [];
  for (let i = 0; i < end; i++) {
    const char = text[i]!;
    if (/\s/.test(char)) continue;
    compact += char;
    offsets.push(i);
  }
  const at = compact.lastIndexOf(target);
  return at < 0 ? null : { from: offsets[at]!, to: offsets[at + target.length - 1]! + 1 };
}

/**
 * A session's transcript with the stop-time heard-as rewrites made to it, so
 * it holds what landed (#14637). The rewritten passages are what the draft
 * still holds, the end of the session, so each is matched from the end back;
 * one no longer found as it was heard stays as it was.
 */
function applyPassageRewrites(text: string, rewrites: readonly PassageRewrite[]): string {
  let next = text;
  let end = text.length;
  for (let i = rewrites.length - 1; i >= 0; i--) {
    const { landed, rewritten } = rewrites[i]!;
    const at = lastIndexOfWords(next, landed, end);
    if (!at) continue;
    next = next.slice(0, at.from) + rewritten + next.slice(at.to);
    end = at.from;
  }
  return next;
}

interface CaptureAttempt {
  target: VoiceRecordingTarget;
  audio: WarmAudio;
  stopObservingContext: (() => void) | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  workletNode: AudioWorkletNode | null;
  // PCM captured before the backend start is requested, sent in order the
  // moment it is. `null` once chunks forward live, or after the attempt is
  // discarded.
  queue: ArrayBuffer[] | null;
  droppedChunks: number;
  timeline: VoiceSessionTimeline;
  deviceId: string | null;
  // UI-only: device names never go into logs.
  deviceLabel: string | null;
  // A working mic other than the chosen one opened; the pane names both.
  substituted: boolean;
  // The chosen mic's saved name, for that notice. UI-only, like deviceLabel.
  chosenLabel: string | null;
  // The OS pulled the track ("ended"). Latched, so a lost attempt is never
  // promoted and a lost session is torn down once.
  lost: boolean;
  // Set when the user stops before the session has begun: no further audio is
  // taken, but the queue is still sent.
  frozen: boolean;
}

// A start from the moment its capture is attached until its queued audio has
// been sent. A stop the user asks for in that window may land on speech that
// is already queued, so it is held here and run once that audio is sent.
interface StartupAttempt {
  requestId: number;
  target: VoiceRecordingTarget;
  capture: CaptureAttempt;
  stopAfterStart: boolean;
  /** Why the held stop was asked for, for the session summary. */
  stopReason: VoiceStopReason;
}

interface HeldPress {
  code: string;
  pressedAt: number;
  claimed: boolean;
  speechChunks: number;
}

class VoiceRecordingService {
  private initialized = false;
  private generation = 0;
  private startRequestId = 0;
  // Id of the promoted session, minted by its start() and carried on every
  // chunk, start and stop main sees, so main can tell which session each
  // belongs to. Unlike `startRequestId` it is unique across project views.
  private sessionId: string | null = null;
  // The dictionary's heard-as rules as last read; every start reads them.
  private heardAsRules: HeardAsRewriter | null = null;
  // Main drops hesitations from every completion; this covers the preview a
  // stop commits without one. English only: "um" is a word in other languages.
  // Main reads the language once per session, so the session keeps the value
  // it started with.
  private dropHesitations = true;
  private sessionDropsHesitations = true;
  // Sessions Escape cancelled. Main ends them without a drain, but whatever
  // they had already sent is still on its way and has nowhere left to land.
  // Each is let go once main reports it ended, the last thing it sends for it.
  private discardedSessionIds = new Set<string>();
  // The panel each discarded session was dictating into: Escape clears the
  // active target at once, and a spoken send still in flight names its panel
  // from here (#15704).
  private discardedSessionPanels = new Map<string, string>();
  // Main has nothing left to send for this one, so cancelling it needs no
  // tombstone (and would leave one behind, with no end notice to clear it).
  private lastEndedSessionId: string | null = null;
  private warmAudio: WarmAudio | null = null;
  // Capture graph built by an in-flight start() and not yet promoted to the
  // session fields below. Held here so a cancel or supersede can release it
  // while getUserMedia is pending (an unanswered permission prompt can leave it
  // pending indefinitely) or while a retarget waits on the previous session's
  // drain with the new microphone already recording into its queue.
  private pendingCapture: CaptureAttempt | null = null;
  private startup: StartupAttempt | null = null;
  private workletNode: AudioWorkletNode | null = null;
  // A stop waiting for this worklet's "flushed" marker.
  private pendingWorkletFlush: { node: AudioWorkletNode; resolve: () => void } | null = null;
  private stream: MediaStream | null = null;
  // The promoted attempt, whose track loss ends the session.
  private sessionCapture: CaptureAttempt | null = null;
  private displacedFallbackNotice: VoiceMicNotice | null = null;
  private trackObserverDisposers = new WeakMap<MediaStream, () => void>();
  private isSwitchingMic = false;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private sessionStartedAt = 0;
  private selectedDeviceId = "";
  private selectedDeviceLabel = "";
  private recordingMode: VoiceRecordingMode = "tap-or-hold";
  // The voice shortcut press that is down right now, outside toggle mode.
  // `claimed` once that press started (or resumed) a recording, so only its
  // release can end it. Cleared on release, stop, window blur, or Escape.
  private heldPress: HeldPress | null = null;
  // When a start claimed a press that hadn't reached the keydown listener yet:
  // the global keybinding listener can be registered first, and dispatch runs
  // the action synchronously. The keydown takes the claim if it came after the
  // event was created.
  private claimedAt: number | null = null;
  private unsubscribers: Array<() => void> = [];
  // A reveal of this view's own session waiting for the view to come on screen.
  private cancelRevealWait: (() => void) | null = null;
  private isStoppingSession = false;
  private stopPromise: Promise<void> | null = null;
  // The stop in flight is the user's own (the key, a second press), and
  // nothing has joined it or started since: a "send it" its drain lands still
  // sends.
  private stopTakesSpokenSend = false;
  // The stop in flight still says it stopped: a "send it" its drain lands on
  // a draft too short to send leaves the composer to say what became of it.
  private stopAnnounces = true;
  private levelRaf: number | null = null;
  private pendingLevel = 0;
  // Session-wide audio-level stats, logged on stop so a captured log can show
  // whether the mic actually picked up speech during the recording.
  private sessionPeakRms = 0;
  private sessionRmsSum = 0;
  private sessionChunkCount = 0;
  // Per-chunk stats for the first ~2s, which is where lost opening words hide
  // (Bluetooth profile switches, Chromium zero-filling an underrunning FIFO).
  private openingAudio: OpeningAudio | null = null;
  // Pause-state tracking. The worklet suppresses PCM emission while paused, the
  // elapsed counter freezes, and a 60s auto-stop terminates the session if the
  // user never resumes — prevents idle Realtime keep-alive charges.
  private pauseStartedAt = 0;
  private totalPausedMs = 0;
  private pauseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pauseWarnTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly PAUSE_AUTO_STOP_MS = 60_000;
  private static readonly PAUSE_WARN_LEAD_MS = 10_000;
  // A listening session that hears no new words (interim text counts) for this
  // long stops as if the dictation key were pressed. Paused sessions keep the
  // 60s rule above.
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // An Escape that would discard dictated words waits this long for a second.
  private cancelConfirmTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Long enough to outlast the replacement words dictated straight after it.
  private scratchRefusalTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private scratchRefusalCount = 0;
  private static readonly SCRATCH_REFUSAL_NOTE_MS = 6_000;
  private fileReferenceNoteCount = 0;
  // Whether the Escape being handled is the key repeating, so holding it
  // down can't press it a second time.
  private escapeRepeat = false;
  private idleWarnTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_AUTO_STOP_MS = 180_000;
  private static readonly IDLE_WARN_LEAD_MS = 10_000;
  // An open stream is not proof of capture: a Bluetooth mic switching to HFP
  // hands Web Audio zeros for a while (#13105). The UI only claims it is
  // listening once a chunk clears the mic-liveness floor (`isMicLive`, not the
  // diagnostics' speech-level `hasRealSignal`), and flags the mic as silent if
  // nothing does within the grace window of unpaused capture. Neither gates PCM
  // forwarding — the leading audio is still captured and held or sent either
  // way.
  private static readonly MIC_SILENCE_GRACE_MS = 3_000;
  // Longer than this between press and release is a hold, not a tap.
  private static readonly HOLD_THRESHOLD_MS = 400;
  // ~200ms of speech-level audio during a hold before its release stops it,
  // so a click or a cough while a thumb lingers on Cmd doesn't count.
  private static readonly HOLD_SPEECH_CHUNKS = 2;
  // A dictation shorter than this keeps its one cleanup pass at stop.
  private static readonly CHUNK_MIN_CHARS = 600;
  // Quiet between one utterance's words landing and the next one's first text.
  private static readonly CHUNK_PAUSE_MS = 1_500;
  // How long words that just landed wait, with nothing more heard, before the
  // stop's cleanup is prefetched: long enough for the rest of one completion's
  // pieces to arrive.
  private static readonly PREFETCH_SETTLE_MS = 150;
  // Past main's 6s file-link job timeout.
  private static readonly FILE_LINK_SETTLE_MS = 6_500;
  private micSilenceTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  // Owner of the silence countdown, so resume can re-arm it for the same
  // capture after a pause cancelled it.
  private micSilenceSession: { generation: number; startRequestId: number } | null = null;
  // performance.now() when the live session's capture was attached.
  private micCaptureAttachedAt = 0;
  // Corrections belong to the passage they were started for, not to a global
  // generation: a session starting anywhere, the same panel included, leaves
  // them to land. Only the draft being sent, cleared or edited over drops one.
  private pendingCorrections = new Set<PendingCorrection>();
  private unwatchCorrectionDrafts: (() => void) | null = null;
  // Each passage's cleanup request still out, by the id its progress comes
  // back under.
  private correctionStreams = new Map<
    string,
    { correction: PendingCorrection; passage: CorrectionPassage; aligner: CorrectionStreamAligner }
  >();
  // The dictation whose cleanup each panel's learning baseline holds. Text
  // alone can't tell two passages dictated with the same words apart.
  private baselineOwners = new Map<string, DictationCleanup>();
  // Each dictation's cleanup across its chunks and the stop-time pass, by
  // session id, until it has stopped and every pass has its reply (#14772).
  private cleanups = new Map<string, DictationCleanup>();
  // The passes each waiting send has seen for its sessions, kept past their
  // settling so the send can say whether its words went without their
  // cleanup (#14959).
  private sendObservers = new Set<{
    panelId: string;
    sessions: ReadonlySet<string>;
    passes: Set<PendingCorrection>;
  }>();
  // Where the live session may cut its next chunk.
  private chunkBreak: ChunkBreak | null = null;
  // performance.now() when the live session's last words landed: a long gap
  // before its next ones is a pause to cut at.
  private lastWordsAt: number | null = null;
  // When each of the live session's transcripts that may name a file has had
  // time for its links to land, by transcript id. A chunk waits for them: a
  // link that resolves after cleanup rewrote its words has nowhere to go.
  private fileLinksDue = new Map<string, number>();
  private unfollowBaselines: (() => void) | null = null;
  private writingShiftedDraft = false;
  // The composer showing each panel's draft, which owns its send, keyed by
  // panel and draft scope: an isolated composer on the same terminal keeps a
  // draft of its own and must not take the pane's send.
  private spokenSendHandlers = new Map<string, (options?: VoiceSendOptions) => void>();
  private pendingRewrites = new Set<PendingRewrite>();
  // Null until the settings have been read: a rewrite then goes ahead and main
  // reports a missing key.
  private hasCleanupKey: boolean | null = null;
  private cleanupKeyIssuer = "OpenAI";
  // Until the settings have been read, the default's pace.
  private cleanupModel: VoiceCorrectionModel = VOICE_CLEANUP_AI_MODEL;
  // Each session's summary until its line is logged, by session id (#14617).
  private timelines = new Map<string, VoiceSessionTimeline>();
  // Starts that reopened a waiting send before their session, and so their
  // summary, existed: the dictation key's press arms the target first (#15704).
  private reopeningStarts = new WeakSet<VoiceRecordingTarget>();
  // The in-flight start's summary, until its capture is promoted.
  private attemptTimeline: VoiceSessionTimeline | null = null;
  // When the dictation shortcut was pressed, for a start in the same dispatch.
  private pendingPressAt: number | null = null;
  private transcriptionProvider: VoiceTranscriptionProvider | null = null;
  // What the session panel reads about the running session (#14920): the
  // provider it started on, whether its clock runs, and when each auto-stop
  // would land.
  private sessionProvider: VoiceTranscriptionProvider | null = null;
  private sessionClockRunning = false;
  private pauseStopsAt: number | null = null;
  private idleStopsAt: number | null = null;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    logDebug(`${LOG_PREFIX} Initializing service`);

    const voiceInput = window.electron?.voiceInput;
    if (!voiceInput) {
      logWarn(`${LOG_PREFIX} window.electron.voiceInput not available`);
      return;
    }

    // A singleton replaced by HMR left its baselines in the store.
    const buffers = Object.values(useVoiceRecordingStore.getState().panelBuffers);
    if (buffers.some((buffer) => buffer.sessionCorrectedText !== null)) {
      this.followLearningBaselines();
    }

    this.unsubscribers.push(
      useVoiceRecordingStore.subscribe((state, prev) => {
        if (state.status === "error" && prev.status !== "error") this.playCue("dictation-error");
      })
    );

    this.unsubscribers.push(
      voiceInput.onTranscriptionDelta(({ sessionId, text: delta, itemId, replace }) => {
        if (this.discardedSessionIds.has(sessionId)) return;
        logDebug(`${LOG_PREFIX} Received transcription delta`, { itemId, length: delta.length });
        if (delta.trim()) this.noteWordsHeard();
        const voiceState = useVoiceRecordingStore.getState();
        const target = voiceState.activeTarget;
        const buffer = target ? voiceState.panelBuffers[target.panelId] : undefined;
        // An instruction streams into liveText only; it never lands in the draft,
        // and nor does a dictation whose draft another screen now drives.
        if (target && !target.rewrite && !isDraftDetached(buffer?.dictationSessionId)) {
          if (delta.trim()) this.timelines.get(sessionId)?.markNextFrame("firstText");
          // An empty revision retracts a preview; it never starts an utterance.
          const isFirstDelta = delta !== "" && (!buffer || buffer.liveText === "");
          if (isFirstDelta) {
            // The preview shows where the words will go, so the session's
            // first utterance takes its anchor from the caret as it starts.
            const draft = useTerminalInputStore
              .getState()
              .getDraftInput(target.panelId, target.projectId);
            resolveVoiceAnchor(target.panelId, target.projectId, buffer?.dictationSessionId, draft);
            this.noteNextWords(sessionId);
          }
          // Interim deltas accumulate in liveText only — the ghost-widget
          // decoration renders them outside the doc model so the editor's
          // history records a single transaction per utterance (#9172).
        }
        useVoiceRecordingStore.getState().appendDelta(delta, itemId, replace);
      })
    );

    this.unsubscribers.push(
      voiceInput.onTranscriptionComplete(
        ({
          sessionId,
          text,
          itemId,
          transcriptId,
          heard,
          send,
          commandText,
          uncertain,
          heardUncertain,
          commandUncertain,
          pauses,
          heardPauses,
          commandPauses,
        }) => {
          if (this.discardedSessionIds.has(sessionId)) {
            // Main has already taken "send it" off the words.
            if (send) {
              logVoiceSendRefused({
                asker: "spoken_send",
                reason: "session_discarded",
                panelId: this.discardedSessionPanels.get(sessionId) ?? null,
                sessionId,
              });
            }
            return;
          }
          logDebug(`${LOG_PREFIX} Received transcription complete`, {
            itemId,
            length: text.length,
          });
          if (text.trim()) this.noteWordsHeard();
          const voiceState = useVoiceRecordingStore.getState();
          const rewrite = voiceState.activeTarget?.rewrite;
          if (rewrite) {
            const finalText = text.trim();
            if (finalText) rewrite.instruction.push(finalText);
            useVoiceRecordingStore.getState().completeSegment(text, itemId);
            return;
          }
          const panelId = voiceState.activeTarget?.panelId;
          const projectId = voiceState.activeTarget?.projectId;
          if (panelId && isDraftDetached(voiceState.panelBuffers[panelId]?.dictationSessionId)) {
            this.keepDetachedWords(panelId, sessionId, text, itemId, send);
            return;
          }
          let completedText = text;
          let completedHeard = heard?.trim();
          let completedUncertain = uncertain;
          let completedHeardUncertain = heardUncertain;
          let completedPauses = pauses;
          let completedHeardPauses = heardPauses;
          if (panelId) {
            const buffer = voiceState.panelBuffers[panelId];
            const spoken = text.trim();
            // "Scratch that, send it" only scratches: the draft it leaves is one
            // the user hasn't seen, and a spoken send fires with no key press.
            if (spoken && isScratchCommand(spoken)) {
              if (send) {
                logVoiceSendRefused({
                  asker: "spoken_send",
                  reason: "scratch_precedence",
                  panelId,
                  sessionId,
                });
              }
              // Recent dictations keep what landed, so scratched words leave the
              // session's transcript with the draft (#14637), every segment a
              // cleaned chunk ran together included.
              const scratch = this.scratchLastUtterance(
                panelId,
                projectId,
                buffer?.dictationSessionId
              );
              if (scratch.kind === "removed") {
                for (let i = 0; i < scratch.sources; i++) {
                  useVoiceRecordingStore.getState().dropLastCompletedSegment(panelId);
                }
                this.clearScratchRefusal();
              } else {
                // Swallowed with nothing removed, the command looked like it worked.
                this.noteScratchRefusal(voiceState.activeTarget!, scratch.reason);
              }
              // What a waiting chunk break was judged on is gone.
              this.chunkBreak = null;
              useVoiceRecordingStore.getState().completeSegment("", itemId, { discard: true });
              return;
            }
            // A spoken command is written as one only when it opens the prompt:
            // the words land at the caret, so text typed ahead of it keeps the
            // command as words. Main writes it from the words as heard, before
            // any heard-as rule, so it has no heard text of its own: the rules
            // reach its arguments at stop, never the spoken words it replaced.
            if (
              commandText &&
              voiceWordsOpenPrompt(panelId, projectId, buffer?.dictationSessionId)
            ) {
              completedText = commandText;
              completedHeard = undefined;
              completedUncertain = commandUncertain;
              completedHeardUncertain = undefined;
              completedPauses = commandPauses;
              completedHeardPauses = undefined;
            }
            const finalText = completedText.trim();
            if (finalText) {
              // A segment that finalised with no preview starts here.
              if (!buffer?.liveText) this.noteNextWords(sessionId);
              // Unsure words are measured against the strings main sent, untrimmed.
              const lead = completedText.length - completedText.trimStart().length;
              const heardLead = (heard?.length ?? 0) - (heard?.trimStart().length ?? 0);
              const { words } = writeVoiceWords(
                panelId,
                projectId,
                buffer?.dictationSessionId,
                finalText,
                transcriptId,
                completedHeard,
                {
                  text: sliceSpans(completedUncertain ?? [], lead, lead + finalText.length),
                  heard: sliceSpans(
                    completedHeardUncertain ?? [],
                    heardLead,
                    heardLead + (completedHeard?.length ?? 0)
                  ),
                },
                {
                  text: slicePausePositions(completedPauses ?? [], lead, lead + finalText.length),
                  heard: slicePausePositions(
                    completedHeardPauses ?? [],
                    heardLead,
                    heardLead + (completedHeard?.length ?? 0)
                  ),
                }
              );
              // A Deepgram span can finalise without any interim, so the session's
              // first text may arrive here rather than in a delta.
              useVoiceRecordingStore.getState().setSessionDraftStart(panelId, words.from);
              if ((buffer?.activeParagraphStart ?? -1) < 0) {
                useVoiceRecordingStore.getState().setActiveParagraphStart(panelId, words.from);
              }
              const timeline = this.timelines.get(sessionId);
              timeline?.addCommitted(finalText.length);
              timeline?.markNextFrame("firstText");
              if (transcriptId) {
                this.fileLinksDue.set(
                  transcriptId,
                  performance.now() + VoiceRecordingService.FILE_LINK_SETTLE_MS
                );
              }
              this.lastWordsAt = performance.now();
              if (!send) {
                this.followChunkBreak(sessionId, finalText);
                this.schedulePrefetch(sessionId);
              }
            } else if (pauses?.includes(0) && buffer?.dictationSessionId) {
              // A pause after words that already landed. What a stop would
              // send now carries it, so the prefetch for them is redone.
              const marked = useDictationRangeStore.getState().markPause({
                sessionId: buffer.dictationSessionId,
                panelId,
                projectId,
              });
              if (marked && !send) this.schedulePrefetch(sessionId);
            }
          }
          // A pause with nothing else to it leaves the live preview alone: an
          // empty completion naming no item would land it as final.
          if (!text.trim() && !itemId && !send) return;
          // What landed, so recent dictations hold a command written as one,
          // and a scratch drops the segment its utterance wrote (#14637).
          useVoiceRecordingStore.getState().completeSegment(completedText, itemId);
          // After completeSegment, so the command's own preview is already retired
          // and a stop that preserves live text can't put it back.
          if (send && panelId) this.handleSpokenSend(panelId, projectId, sessionId);
        }
      )
    );

    this.unsubscribers.push(
      voiceInput.onFileTokenResolved(({ sessionId, transcriptId, references }) => {
        if (this.discardedSessionIds.has(sessionId)) return;
        logDebug(`${LOG_PREFIX} Received file references`, { count: references.length });
        this.fileLinksDue.delete(transcriptId);
        try {
          // Routed by the session that spoke them, not the active target: the
          // final utterance's references arrive as its session stops, by which
          // point another panel may be dictating.
          const record = useDictationRangeStore
            .getState()
            .listSessionDictations(sessionId)
            .find((r) => r.utterances.some((u) => u.transcriptId === transcriptId));
          if (!record) {
            logDebug(`${LOG_PREFIX} File references' dictation is gone, discarding`);
            return;
          }

          const { panelId, projectId } = record;
          // Words no file was found for stay as spoken; the composer says so,
          // whether or not a hit beside them lands (#14983).
          const unresolved = references.filter((reference) => !reference.path);
          if (unresolved.length > 0) this.noteUnresolvedFileReferences(panelId, unresolved);
          const inputStore = useTerminalInputStore.getState();
          const draft = inputStore.getDraftInput(panelId, projectId);
          const edits = planFileReferenceEdits(record, transcriptId, references, draft);
          if (edits.length === 0) {
            logDebug(`${LOG_PREFIX} File references not found in their words, discarding`, {
              count: references.length,
            });
            return;
          }
          // An utterance still being dictated on the panel sliced its start from
          // the draft before the swap; its offsets move with the new lengths.
          const voiceStore = useVoiceRecordingStore.getState();
          for (let i = edits.length - 1; i >= 0; i--) {
            const edit = edits[i]!;
            voiceStore.shiftDraftOffsets(
              panelId,
              edit.to,
              edit.text.length - (edit.to - edit.from)
            );
          }
          // The words were dictated, and still are: the link is theirs, not an edit.
          useDictationRangeStore.getState().rewriteWords(
            record.id,
            edits,
            (next) => {
              // Spelled out, so words between two swaps aren't taken as rewritten.
              useDictationRangeStore
                .getState()
                .expectDraftChange(panelId, projectId, draft, next, draftChanges(draft, edits));
              this.writeShiftedDraft(panelId, next, projectId);
            },
            planHeardSwaps(record, edits, draft, this.heardAsRules)
          );
          inputStore.bumpExternalDraftRevision({ keepsSelection: true });
        } finally {
          // A chunk held back for these links can go now, and so can the
          // prefetch a pause held back for them.
          this.settleChunkBreak(false);
          this.schedulePrefetch(sessionId);
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onCorrectionProgress(({ streamId, text }) =>
        this.noteCorrectionProgress(streamId, text)
      )
    );

    this.unsubscribers.push(
      voiceInput.onParagraphBoundary(({ sessionId, rawText }) => {
        if (this.discardedSessionIds.has(sessionId)) return;
        logDebug(`${LOG_PREFIX} Received paragraph boundary`, { rawLength: rawText?.length ?? 0 });
        const voiceState = useVoiceRecordingStore.getState();
        const currentTarget = voiceState.activeTarget;
        if (!currentTarget || currentTarget.rewrite) return;

        const { panelId, projectId } = currentTarget;
        const buffer = voiceState.panelBuffers[panelId];
        if (!buffer) return;

        const { dictationSessionId } = buffer;
        if (isDraftDetached(dictationSessionId)) return;
        const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
        const plan = planVoiceBreak(
          draft,
          resolveVoiceAnchor(panelId, projectId, dictationSessionId, draft)
        );
        commitVoicePlan(panelId, projectId, dictationSessionId, plan, (target, { insertion }) =>
          useDictationRangeStore.getState().recordParagraphBreak(target, insertion)
        );

        voiceState.resetParagraphState(panelId);
        this.proposeChunkBreak(sessionId, true);
      })
    );

    this.unsubscribers.push(
      voiceInput.onError(({ sessionId, error }) => {
        if (this.discardedSessionIds.has(sessionId)) return;
        // One passage went untranscribed. It can land while the stop drains,
        // and it never ends the session, so it is handled before either gate.
        if (error.code === TRANSCRIPTION_ITEM_FAILED_CODE) {
          this.reportPassageFailed();
          return;
        }
        // Speech the stop couldn't get transcribed. Nothing else would tell the
        // user, and it ends nothing: the drain carries on to idle.
        // Speech a reconnect can no longer resend. Dictation carries on, and it
        // can land while a stop drains.
        if (error.code === VOICE_REPLAY_AUDIO_LOST_CODE) {
          this.reportReplayAudioLost(error.message);
          return;
        }
        if (error.code === VOICE_STOP_AUDIO_LOST_CODE) {
          logWarn(`${LOG_PREFIX} Stop lost held audio`, { code: error.code });
          notify({
            type: "warning",
            title: "Dictation incomplete",
            // eslint-disable-next-line no-restricted-syntax -- raw error.message: VoiceInputError is constructed internally with well-formed user copy
            message: error.message,
            context: { eventKind: "connectivity" },
          });
          return;
        }
        // An error that lands while a stop drains belongs to a session already
        // winding down: it mustn't set an error state or toast over a stop the
        // user asked for.
        if (this.isStoppingSession) {
          logWarn(`${LOG_PREFIX} Ignoring error during stop`, {
            severity: error.severity,
            code: error.code,
          });
          return;
        }
        logError(`${LOG_PREFIX} Received error from backend`, undefined, {
          severity: error.severity,
          code: error.code,
        });
        useVoiceRecordingStore.getState().setLastError(error);

        // Transient errors (rate-limit, transport drop) are recoverable — the
        // main process is already reconnecting. Store the error for tooltip
        // context but keep the session alive; the reconnecting status update
        // arriving on the same channel will update the UI.
        if (error.severity === "transient") {
          return;
        }

        // Fatal error — tear down the session and surface a toast so the user
        // knows action is needed (check API key, network, etc.).
        notify({
          type: "error",
          title: "Dictation stopped",
          action: this.settingsAction(),
          // eslint-disable-next-line no-restricted-syntax -- raw error.message: VoiceInputError is constructed internally with well-formed user copy
          message: error.message,
          context: { eventKind: "connectivity" },
        });
        void this.stop("Dictation stopped because the connection failed.", {
          skipRemoteStop: true,
          nextStatus: "error",
          preserveLiveText: true,
          reason: "provider_error",
        });
      })
    );

    this.unsubscribers.push(
      voiceInput.onStatus(({ sessionId, status }) => {
        if (this.discardedSessionIds.has(sessionId)) return;
        logDebug(`${LOG_PREFIX} Received status from backend`, {
          status,
          isStoppingSession: this.isStoppingSession,
        });
        if (status === "recording") this.timelines.get(sessionId)?.mark("socketReady");
        // A replaced session's drain still reports here after this view may
        // have finished it locally; its statuses aren't this session's.
        if (sessionId !== this.sessionId) return;
        // Nothing here asked for this drain: a start in another view replaced
        // the session. Release the mic now, and join the drain so its last
        // text still lands in this view's draft before the session finishes.
        if (status === "finishing" && !this.isStoppingSession && !this.stopPromise) {
          void this.stop(REPLACED_ELSEWHERE_ANNOUNCEMENT, {
            preserveLiveText: true,
            skipCorrection: true,
            reason: "superseded",
          });
          return;
        }
        if (status !== "idle") {
          const prevStatus = useVoiceRecordingStore.getState().status;
          // Local "paused" is a renderer-only override that gates worklet PCM
          // emission. The backend doesn't know about it and will continue to
          // emit "recording" / "reconnecting" on its own schedule. Letting those
          // overwrite the store would silently exit pause: the worklet stays
          // gated, the elapsed timer stays frozen, and togglePause() routes to
          // pause() again instead of resume(). Genuine teardown signals
          // ("error") still flow through; "idle" is handled below.
          const isBenignBackendTick = status === "recording" || status === "reconnecting";
          if (prevStatus === "paused" && isBenignBackendTick) {
            return;
          }
          // A stop that landed before the backend was ready drains a provider
          // that is still coming up; its start-up ticks must not pull the UI
          // back out of "finishing".
          if (this.isStoppingSession && (status === "connecting" || isBenignBackendTick)) {
            return;
          }
          useVoiceRecordingStore.getState().setStatus(status);
          // Announce the reconnect once on entry — the backend re-emits
          // "reconnecting" on every retry, so guard against repeat announcements.
          if (status === "reconnecting" && prevStatus !== "reconnecting") {
            useVoiceRecordingStore.getState().announce("Reconnecting dictation…");
          }
        }

        if (this.isStoppingSession) {
          return;
        }

        if (status === "idle" && useVoiceRecordingStore.getState().activeTarget) {
          logDebug(`${LOG_PREFIX} Backend went idle while session active, stopping`);
          void this.stop("Dictation stopped.", {
            skipRemoteStop: true,
            preserveLiveText: true,
            reason: "provider_ended",
          });
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onSessionEnded(({ sessionId, reason, report }) => {
        logDebug(`${LOG_PREFIX} Backend session ended`, {
          sessionId,
          reason,
          current: sessionId === this.sessionId,
        });
        this.timelines.get(sessionId)?.reportEnded(reason, report);
        this.lastEndedSessionId = sessionId;
        this.discardedSessionIds.delete(sessionId);
        this.discardedSessionPanels.delete(sessionId);
        // Replaced elsewhere before it had anything to drain, typically while
        // its start was still pending. Its start result is stale from here.
        if (reason !== "superseded" || sessionId !== this.sessionId) return;
        if (this.isStoppingSession || this.stopPromise) return;
        void this.stop(REPLACED_ELSEWHERE_ANNOUNCEMENT, {
          skipRemoteStop: true,
          preserveLiveText: true,
          reason: "superseded",
        });
      })
    );

    // Where the live session is, when another view owns it. Pulled as well as
    // pushed: a view that boots mid-session missed the push.
    this.unsubscribers.push(
      voiceInput.onLiveSession((update) =>
        useVoiceRecordingStore.getState().applyLiveSessionUpdate(update)
      )
    );
    voiceInput
      .getLiveSession()
      .then((update) => useVoiceRecordingStore.getState().applyLiveSessionUpdate(update))
      .catch((error: unknown) => {
        logDebug(`${LOG_PREFIX} Couldn't read the live session`, voiceErrorLogFields(error));
      });
    this.unsubscribers.push(voiceInput.onLiveLevel((level) => setElsewhereLevel(level)));
    this.unsubscribers.push(() => setElsewhereLevel(null));

    // What this view shows of a session it owns, for every other view's
    // indicator and control panel (#14921).
    this.unsubscribers.push(
      startVoiceDetailsPublisher(
        {
          sessionId: () => this.sessionId,
          clock: (now) => this.getSessionClock(now),
          hostId: () => currentHostId(),
        },
        (request) =>
          voiceInput.publishDetails(request).catch((error: unknown) => {
            logDebug(`${LOG_PREFIX} Couldn't report the session`, voiceErrorLogFields(error));
            return false;
          })
      )
    );

    // Another view's dictation key or indicator, for a session this view owns.
    this.unsubscribers.push(
      voiceInput.onStopRequested(({ sessionId, returnToTarget }) => {
        if (sessionId === this.sessionId) {
          // A press still down here belongs to the session ending now, so its
          // release mustn't act on whatever runs by then.
          this.dropHeldPress();
          void this.stopAnySession(returnToTarget === true ? { pressedHere: false } : undefined);
          // Dictation turned off in another view asks this way too, and that
          // view's settings event never reaches this one (#14947).
          void this.refreshConfiguration();
          return;
        }
        // Started here before a reload: nothing in this view holds its
        // microphone or its text, so only main has anything left to end.
        voiceInput.stop(sessionId).catch((error: unknown) => {
          logDebug(`${LOG_PREFIX} Couldn't end an orphaned session`, voiceErrorLogFields(error));
        });
      })
    );
    this.unsubscribers.push(
      voiceInput.onPauseRequested(({ sessionId, paused }) => {
        if (sessionId !== this.sessionId) return;
        if (paused) this.pause();
        else this.resume();
      })
    );
    this.unsubscribers.push(
      voiceInput.onRevealRequested(({ sessionId, hostId, workspaceId }) => {
        if (sessionId === this.sessionId) {
          this.revealOwnTarget();
          return;
        }
        // On screen in the owner's window: bring the owner's workspace forward,
        // on the owner's host.
        if (workspaceId) void this.showWorkspaceOn(hostId, workspaceId);
      })
    );

    this.unsubscribers.push(window.electron.systemSleep.onSuspend(() => void this.handleSuspend()));
    this.unsubscribers.push(
      window.electron.systemSleep.onWake(() => {
        if (useVoiceRecordingStore.getState().activeTarget) {
          void this.stop("Dictation stopped after system sleep.", {
            skipRemoteStop: true,
            preserveLiveText: true,
            reason: "wake",
          });
        }
      })
    );

    const handleSettingsChanged = () => {
      void this.refreshConfiguration();
    };

    window.addEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    this.unsubscribers.push(() =>
      window.removeEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    );

    this.unsubscribers.push(
      usePanelStore.subscribe((state) => {
        // If a target belongs to a different project than the one currently
        // loaded, the panel's absence is expected.
        const currentProjectId = useProjectStore.getState().currentProject?.id;
        const isClosed = (target: VoiceRecordingTarget) => {
          // A Canopy reply names no panel; its row going away is Canopy's to handle.
          if (isCanopyReplyTarget(target)) return false;
          if (target.projectId && currentProjectId !== target.projectId) return false;
          const found = state.panelsById[target.panelId];
          return !found || found.location === "trash";
        };

        // A start waiting behind another session has no session of its own to
        // stop when its panel goes.
        const { pendingTarget, activeTarget: sessionTarget } = useVoiceRecordingStore.getState();
        if (
          pendingTarget &&
          pendingTarget.panelId !== sessionTarget?.panelId &&
          isClosed(pendingTarget)
        ) {
          this.cancelArming("panel_closed");
        }

        const voiceState = useVoiceRecordingStore.getState();
        const activeTarget = voiceState.activeTarget;
        if (!activeTarget) return;

        if (isClosed(activeTarget)) {
          // No microphone has opened yet during arming — fall back to
          // cancelArming() so we don't drive stop() through a non-existent
          // session.
          if (voiceState.status === "arming") {
            this.cancelArming("panel_closed");
            // No words yet, and nothing else clears a buffer it left behind.
            useVoiceRecordingStore.getState().clearPanelBuffer(activeTarget.panelId);
            return;
          }
          const panelId = activeTarget.panelId;
          const pendingTarget = voiceState.pendingTarget;
          void this.stop("Dictation stopped because its panel was closed.", {
            preserveLiveText: true,
            reason: "panel_closed",
            // A start waiting on this session for another, open panel goes ahead.
            preservePendingStart: pendingTarget !== null && pendingTarget.panelId !== panelId,
          }).then(() => {
            useVoiceRecordingStore.getState().clearPanelBuffer(panelId);
          });
        }
      })
    );

    // Read once now too: a view can open already driven from elsewhere.
    this.unsubscribers.push(subscribeTerminalInputGate(() => this.followDriveLease()));
    this.followDriveLease();

    // Dictation takes Escape only once every overlay, menu, dialog and focused
    // widget has had its turn; the target composer hands it over itself.
    this.unsubscribers.push(registerEscapeFallback(() => this.handleEscape()));

    // A capture-phase keydown listener sees each voice shortcut press. Its
    // time is the origin of the session summary the press starts, and in
    // push-to-talk and tap-or-hold it records the physical key code so the
    // keyup listener can match it. The actual `start()` call happens via the
    // normal action dispatch chain, which always awaits before the action
    // runs, so the press is recorded before the start that claims it. A press
    // that completes a chord (Cmd+K Cmd+D) or stops a session is never
    // claimed, and its release does nothing.
    const handleShortcutKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.escapeRepeat = e.repeat;
      if (e.repeat) return;
      // Every combo that starts recording has to arm the release, or a second
      // override combo would start push-to-talk that its keyup can't stop.
      const matches = [
        ...keybindingService.getEffectiveCombos("voiceInput.toggle"),
        ...keybindingService.getEffectiveCombos("voiceInput.toggleAssistant"),
        ...keybindingService.getEffectiveCombos("voiceInput.rewriteSelection"),
      ].some((combo) => keybindingService.matchesEvent(e, combo));
      if (!matches) return;
      this.noteShortcutPress(e.timeStamp);
      if (this.recordingMode === "toggle") return;
      const claimed = this.claimedAt !== null && this.claimedAt >= e.timeStamp;
      this.claimedAt = null;
      this.heldPress = {
        code: e.code,
        pressedAt: performance.now(),
        claimed,
        speechChunks: 0,
      };
    };
    window.addEventListener("keydown", handleShortcutKeyDown, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keydown", handleShortcutKeyDown, { capture: true })
    );

    // Release of the trigger key. macOS swallows the trigger keyup if a
    // modifier (Cmd/Meta) is still held, so MetaLeft/MetaRight keyup also
    // counts as the release. Modifier-only releases (Shift, Alt, Ctrl) do not —
    // only the physical trigger key or Meta release.
    const handlePttKeyUp = (e: KeyboardEvent) => {
      if (this.heldPress === null) return;
      const isTriggerRelease = e.code === this.heldPress.code;
      const isMetaRelease = e.code === "MetaLeft" || e.code === "MetaRight";
      if (!isTriggerRelease && !isMetaRelease) return;
      this.releaseHeldPress("key_release");
    };
    window.addEventListener("keyup", handlePttKeyUp, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keyup", handlePttKeyUp, { capture: true })
    );

    // Window blur safety net. Chromium does NOT dispatch a synthetic keyup
    // when the window loses focus, so a Cmd+Tab mid-press would otherwise
    // leave the press held forever. Blur counts as the release.
    const handlePttBlur = () => {
      if (this.heldPress === null) return;
      this.releaseHeldPress("window_blur");
    };
    window.addEventListener("blur", handlePttBlur);
    this.unsubscribers.push(() => window.removeEventListener("blur", handlePttBlur));

    void this.refreshConfiguration();
  }

  async refreshConfiguration(): Promise<boolean> {
    const settings = await window.electron.voiceInput.getSettings();
    // "Configured" means the selected provider has its own API key. The cleanup
    // provider's key is a separate matter: it only gates cleanup and rewrite.
    const hasProviderKey = hasTranscriptionKey(settings);
    const isConfigured = settings.enabled && hasProviderKey;
    this.selectedDeviceId = settings.deviceId ?? "";
    this.selectedDeviceLabel = settings.deviceLabel ?? "";
    this.recordingMode = settings.recordingMode ?? "tap-or-hold";
    this.hasCleanupKey = hasCleanupKey(settings);
    this.cleanupKeyIssuer = cleanupKeyIssuer(settings.correctionProvider);
    this.cleanupModel = settings.correctionModel;
    this.transcriptionProvider = settings.transcriptionProvider;
    this.heardAsRules = createHeardAsRewriter(collectHeardAsRules(settings.dictionary ?? []));
    this.dropHesitations = normalizeVoiceLanguage(settings.language) === "en";
    logDebug(`${LOG_PREFIX} refreshConfiguration`, {
      enabled: settings.enabled,
      provider: settings.transcriptionProvider,
      hasProviderKey,
      isConfigured,
      correctionEnabled: settings.correctionEnabled,
      recordingMode: this.recordingMode,
    });
    // Keep correction state in sync for live-segment dimming
    useVoiceRecordingStore
      .getState()
      .setCorrectionEnabled(!!(settings.correctionEnabled && hasCleanupKey(settings)));
    useVoiceRecordingStore
      .getState()
      .setLearnFromCorrections(settings.learnFromCorrections !== false);
    useVoiceRecordingStore.getState().setConfigured(isConfigured);
    return isConfigured;
  }

  async toggle(target: VoiceRecordingTarget): Promise<void> {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    const isActiveTarget = state.activeTarget?.panelId === target.panelId;
    const isActive = this.isStoppableSession(state.status);

    logDebug(`${LOG_PREFIX} toggle`, {
      panelId: target.panelId,
      isActiveTarget,
      isActive,
      status: state.status,
    });

    if (this.resumeReleasedStartup(target)) {
      this.claimHeldPress();
      return;
    }

    const stopping = this.stopPanelDictation(target.panelId);
    if (stopping) {
      await stopping;
      return;
    }

    // Words for a draft another screen drives would never be saved (#15919).
    const driven = drivenElsewhereFor(target.projectId);
    if (driven) {
      this.reportDrivenStart(driven);
      return;
    }

    // Refresh recent-targets MRU on confirmed routing (before any await so the
    // entry reflects the user's intent even if start() bails later — recent
    // targets are a navigation aid, not a session log).
    useVoiceRecordingStore.getState().recordRecentTarget(target);
    this.claimHeldPress();
    focusDictationComposer(target.panelId);

    // Synchronous pre-audio cue. setArming() resolves under 1ms (Zustand set);
    // the first await inside start() then carries us to "connecting" within
    // ~50–200ms, by which point beginSession() has overwritten this state.
    this.armTarget(target);
    await this.start(target);
  }

  /**
   * Ends the dictation starting or running in `panelId`, as a second press of
   * its toggle does, and never starts or resumes one, so it needs no composer
   * there. Null when there's nothing in that panel to stop.
   */
  stopPanelDictation(panelId: string): Promise<void> | null {
    const state = useVoiceRecordingStore.getState();
    const isActiveTarget = state.activeTarget?.panelId === panelId;
    // A second press during the arming window aborts back to idle. No session
    // exists yet, so there is nothing for stop() to drain — cancelArming()
    // releases whatever the in-flight start() has opened and makes it bail at
    // its next staleness check, discarding any audio it already queued.
    // Once the mic is recording into the start's queue, the press keeps that
    // speech and ends the session after it is sent.
    if (state.pendingTarget?.panelId === panelId || (isActiveTarget && state.status === "arming")) {
      if (!this.deferStopToStartup("user")) this.cancelArming("user");
      return Promise.resolve();
    }
    if (isActiveTarget && this.isStoppableSession(state.status)) {
      return this.requestUserStop("user");
    }
    return null;
  }

  /**
   * Escape that reached dictation, from the global fallback or from the target
   * composer (`panelId`). It cancels the dictation, taking its text back out of
   * the draft, unless that text has been edited: then it stops and keeps it,
   * as the dictation key does. A cancel that would take words out asks for a
   * second Escape first (#14927); the session carries on meanwhile. Returns
   * whether it acted, so a finishing or idle session leaves the key to
   * whatever is next in line.
   */
  handleEscape(panelId?: string): boolean {
    const state = useVoiceRecordingStore.getState();
    // A start that hasn't begun its session: cancel it, and let any session
    // still finishing drain.
    if (
      state.pendingTarget &&
      !this.isStoppableSession(state.status) &&
      (panelId === undefined || state.pendingTarget.panelId === panelId)
    ) {
      this.cancelArming("escape");
      return true;
    }
    if (panelId !== undefined && state.activeTarget?.panelId !== panelId) return false;
    const rewrite = state.activeTarget?.rewrite;
    // A rewrite still draining its instruction is cancelled, not left to land.
    if (rewrite && state.status === "finishing") {
      if (rewrite.cancelled) return false;
      rewrite.cancelled = true;
      useVoiceRecordingStore.getState().announce("Rewrite cancelled.");
      return true;
    }
    // Arming is the pre-audio confirmation window. No session has begun
    // yet, so route abort through cancelArming() instead of stop() —
    // stop() would log "no active session" warnings and skip the cleanup
    // path that resets activeTarget back to null.
    if (state.status === "arming") {
      this.cancelArming("escape");
      return true;
    }
    if (
      state.status !== "connecting" &&
      state.status !== "recording" &&
      state.status !== "paused" &&
      state.status !== "reconnecting"
    ) {
      return false;
    }
    const target = state.activeTarget;
    // A stop already under way keeps what it has.
    if (!target || this.stopPromise) return false;
    // An instruction never reached the draft, so there is nothing to take out.
    if (rewrite) {
      void this.cancelDictation(target, null, []);
      return true;
    }

    const record = findDictation(
      target,
      state.panelBuffers[target.panelId]?.dictationSessionId ?? null
    );
    const draft = useTerminalInputStore.getState().getDraftInput(target.panelId, target.projectId);
    const spans = record ? dictatedSpans(record, draft) : [];
    if (!spans) {
      this.clearCancelConfirm();
      void this.stop(
        "Dictation stopped. Its text was kept because it changed after you dictated it.",
        { preserveLiveText: true, reason: "escape" }
      );
      return true;
    }
    // Only a cancel that changes the draft or drops words still being heard
    // loses anything, read afresh on every press: what landed while the first
    // waited goes too.
    const buffer = state.panelBuffers[target.panelId];
    const sessionId = buffer?.dictationSessionId ?? null;
    const hearing = (buffer?.liveText.trim() ?? "") !== "";
    if (sessionId && (hearing || draftAfterCancel(spans, draft) !== draft)) {
      const confirm = state.dictationCancelConfirm;
      const confirmed =
        confirm?.panelId === target.panelId &&
        confirm.sessionId === sessionId &&
        performance.now() < confirm.expiresAt;
      if (!confirmed) {
        this.armCancelConfirm(target.panelId, sessionId);
        // A reply box's own composer says it while Canopy is open: the app's
        // announcer goes unheard inside its dialog.
        if (!isCanopyReplyTarget(target) || !useCanopyStore.getState().isOpen) {
          useVoiceRecordingStore.getState().announce(DICTATION_CANCEL_CONFIRM_PROMPT);
        }
        return true;
      }
      if (this.escapeRepeat) return true;
    }
    void this.cancelDictation(target, record, spans);
    return true;
  }

  private armCancelConfirm(panelId: string, sessionId: string): void {
    this.clearCancelConfirm();
    const confirm = { panelId, sessionId, expiresAt: performance.now() + PRESS_AGAIN_CONFIRM_MS };
    useVoiceRecordingStore.getState().setDictationCancelConfirm(confirm);
    this.cancelConfirmTimeoutId = setTimeout(() => {
      this.cancelConfirmTimeoutId = null;
      // A newer press or the session's end may have replaced it already.
      const store = useVoiceRecordingStore.getState();
      if (store.dictationCancelConfirm === confirm) store.setDictationCancelConfirm(null);
    }, PRESS_AGAIN_CONFIRM_MS);
  }

  private noteScratchRefusal(
    target: VoiceRecordingTarget,
    reason: VoiceScratchRefusal["reason"]
  ): void {
    if (this.scratchRefusalTimeoutId !== null) clearTimeout(this.scratchRefusalTimeoutId);
    const refusal = { panelId: target.panelId, reason, id: ++this.scratchRefusalCount };
    const store = useVoiceRecordingStore.getState();
    if (store.fileReferenceNote?.panelId === target.panelId) store.setFileReferenceNote(null);
    store.setScratchRefusal(refusal);
    // A reply box's own composer says it while Canopy is open: the app's
    // announcer goes unheard inside its dialog.
    if (!isCanopyReplyTarget(target) || !useCanopyStore.getState().isOpen) {
      store.announce(SCRATCH_REFUSAL_STATUS[reason]);
    }
    this.scratchRefusalTimeoutId = setTimeout(() => {
      this.scratchRefusalTimeoutId = null;
      // A new session or a closed panel may have dropped it already.
      const current = useVoiceRecordingStore.getState();
      if (current.scratchRefusal === refusal) current.setScratchRefusal(null);
    }, VoiceRecordingService.SCRATCH_REFUSAL_NOTE_MS);
  }

  private noteUnresolvedFileReferences(
    panelId: string,
    references: readonly SpokenFileReference[]
  ): void {
    const store = useVoiceRecordingStore.getState();
    // One note on a composer's border at a time, the newer.
    if (store.scratchRefusal?.panelId === panelId) this.clearScratchRefusal();
    const note = {
      panelId,
      references: references.map(({ description, failed }) => ({
        description,
        ...(failed ? { failed } : {}),
      })),
      id: ++this.fileReferenceNoteCount,
    };
    store.setFileReferenceNote(note);
    // As a scratch refusal: a reply box's own composer says it while Canopy
    // is open. The session may have finished already, so its target is read
    // only while it still names this composer.
    const target = store.activeTarget;
    const canopyReply = target?.panelId === panelId && isCanopyReplyTarget(target);
    if (!canopyReply || !useCanopyStore.getState().isOpen) {
      store.announce(unresolvedFileReferencesStatus(note.references));
    }
  }

  private clearScratchRefusal(): void {
    if (this.scratchRefusalTimeoutId !== null) {
      clearTimeout(this.scratchRefusalTimeoutId);
      this.scratchRefusalTimeoutId = null;
    }
    const store = useVoiceRecordingStore.getState();
    if (store.scratchRefusal) store.setScratchRefusal(null);
  }

  private clearCancelConfirm(): void {
    if (this.cancelConfirmTimeoutId !== null) {
      clearTimeout(this.cancelConfirmTimeoutId);
      this.cancelConfirmTimeoutId = null;
    }
    const store = useVoiceRecordingStore.getState();
    if (store.dictationCancelConfirm) store.setDictationCancelConfirm(null);
  }

  /**
   * Ends the session without draining it and takes the text it wrote back out
   * of the draft (#14631). Everything before the teardown's first await runs
   * in the Escape's own tick, so nothing the session still has in flight can
   * land between the removal and the end of the session. No correction runs:
   * there is nothing left to correct.
   */
  private async cancelDictation(
    target: VoiceRecordingTarget,
    record: DictationRecord | null,
    spans: DictatedSpan[]
  ): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId && sessionId !== this.lastEndedSessionId) {
      this.discardedSessionIds.add(sessionId);
      this.discardedSessionPanels.set(sessionId, target.panelId);
    }
    // Nothing of the dictation is kept, so no chunk of it lands or is recorded.
    this.resetChunking();
    const dictationId =
      useVoiceRecordingStore.getState().panelBuffers[target.panelId]?.dictationSessionId;
    const cleanup = dictationId ? this.cleanups.get(dictationId) : undefined;
    if (cleanup) {
      cleanup.stopped = true;
      cleanup.history = null;
      this.cleanups.delete(cleanup.sessionId);
    }
    // A rewrite's timeline was disposed at its start, so only a dictation's is found.
    const timeline = sessionId ? this.timelines.get(sessionId) : undefined;
    timeline?.mark("stopRequested");
    this.dropHeldPress();
    this.invalidatePendingStart("escape");
    this.clearTimers();
    // The worklet forwards and meters nothing more for this session.
    this.generation++;
    const wasMicLive = useVoiceRecordingStore.getState().micSignal === "live";

    // Before the removals, so none of them stops to carry an anchor along.
    releaseActiveVoiceAnchors();
    if (record) {
      const { panelId, projectId } = target;
      const inputStore = useTerminalInputStore.getState();
      const draft = inputStore.getDraftInput(panelId, projectId);
      const draftKey = makeDraftKey(panelId, projectId);
      const caret =
        peekPendingComposerSelection(draftKey, draft) ?? readComposerSelection(draftKey, draft);
      // Last first, so each removal leaves the earlier offsets where they were.
      // Each is written on its own and spelled out, so other sessions' ranges
      // and the text typed between ours follow what was actually removed, not
      // a diff's guess across the whole stretch.
      // Words that were the selection leave the text as it is, so only the
      // spans that change it are written.
      const applied = spans.filter((span) => changesDraft(span, draft));
      let next = draft;
      for (const { from, to, restore = "" } of applied) {
        const before = next;
        next = before.slice(0, from) + restore + before.slice(to);
        useDictationRangeStore
          .getState()
          .expectDraftChange(panelId, projectId, before, next, { from, to, insert: restore });
        inputStore.setDraftInput(panelId, next, projectId);
      }
      const reselect = restoredSelection(spans, applied, caret);
      if (next !== draft || reselect) {
        // The selection comes back where its words stood; any other caret
        // stays on the text it was in, wherever the removals left it.
        if (reselect) {
          setPendingComposerSelection(draftKey, next, reselect);
        } else if (caret) {
          setPendingComposerSelection(draftKey, next, {
            from: offsetAfterRemoving(caret.from, applied),
            to: offsetAfterRemoving(caret.to, applied),
          });
        }
        // Like a scratch, an edit rather than a send: the composer keeps its
        // undo history even when the cancel empties the draft.
        if (next !== draft) recordScratchLanded(panelId, projectId, next);
        inputStore.bumpExternalDraftRevision({ keepsSelection: true });
      }
      useDictationRangeStore.getState().releaseDictation(record.id);
    }
    // A cancelled rewrite drops its instruction and gives the selection back
    // as it was.
    const { rewrite } = target;
    if (rewrite) rewrite.selection.release();
    useVoiceRecordingStore.getState().finishSession({ preserveLiveText: false });
    // Words taken back out of the draft never landed, so recent dictations
    // keep no entry for them (#14637), and the buffer lets them go too.
    useVoiceRecordingStore.getState().consumeCompletedSegments(target.panelId);
    useVoiceRecordingStore
      .getState()
      .announce(rewrite ? "Rewrite cancelled." : "Dictation cancelled. Its text was discarded.");
    logInfo(`${LOG_PREFIX} ${rewrite ? "Rewrite" : "Dictation"} cancelled`, {
      removedSpans: spans.length,
    });
    // Nothing the session still sends can land, so the draft is final now. In
    // the Escape's own tick, so a stale start that ends the session later
    // can't name it first.
    timeline?.mark("settled");
    timeline?.finish("escape");

    if (this.openingAudio) this.flushOpeningAudio(this.openingAudio);
    this.cleanupAudioCapture();
    // After capture closes, as for a stop, and only where the start was cued.
    if (wasMicLive) this.playCue("dictation-stop");
    const remoteCancel = sessionId
      ? window.electron.voiceInput.cancel(sessionId).catch(() => {})
      : null;
    // A start that follows waits on this, as it would on a stop.
    this.stopPromise = (async () => {
      await remoteCancel;
      if (this.sessionId === sessionId) this.sessionId = null;
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * Abort an in-flight arming window before a session begins. Bumping
   * startRequestId invalidates any pending start() so it bails at its next
   * staleness check; finishSession() returns the store to idle without
   * touching panel buffers (no transcript exists yet).
   */
  private cancelArming(reason: VoiceStopReason): void {
    // A held press that aborted arming must not have its keyup send a stop
    // for a session that never began.
    this.heldPress = null;
    this.invalidatePendingStart(reason);
    // A start queued behind a session that is still finishing leaves that
    // session's target and status to its own stop.
    if (useVoiceRecordingStore.getState().status === "arming") {
      releaseActiveVoiceAnchors();
      useVoiceRecordingStore.getState().finishSession({ nextStatus: "idle" });
    }
  }

  /**
   * Make any in-flight start() stale and release the capture graph it built
   * ahead of its session, so a start stuck on a pending permission prompt or a
   * retarget drain doesn't hold the microphone or an output stream open after
   * the user has moved on.
   */
  private invalidatePendingStart(reason?: VoiceStopReason): void {
    this.releasePendingRewrite();
    this.startRequestId++;
    this.startup = null;
    this.releasePendingCapture();
    useVoiceRecordingStore.getState().clearPendingTarget();
    // Closed here rather than when its awaits return: a permission prompt may
    // never settle.
    const attempt = this.attemptTimeline;
    this.attemptTimeline = null;
    if (attempt && reason) attempt.finish(reason);
  }

  /**
   * The dictation shortcut was pressed. A start the same dispatch already ran
   * takes it now (the keybinding listener can fire before this one); otherwise
   * it waits for one until the event's task is over.
   */
  private noteShortcutPress(at: number): void {
    if (this.attemptTimeline?.notePress(at)) return;
    this.pendingPressAt = at;
    setTimeout(() => {
      if (this.pendingPressAt === at) this.pendingPressAt = null;
    }, 0);
  }

  private openTimeline(sessionId: string, target: VoiceRecordingTarget): VoiceSessionTimeline {
    const pressedAt = this.pendingPressAt;
    this.pendingPressAt = null;
    const timeline = new VoiceSessionTimeline(
      sessionId,
      {
        now: () => performance.now(),
        log: logInfo,
        warn: logWarn,
        nextFrame: (callback) => {
          const frame = requestAnimationFrame(callback);
          return () => cancelAnimationFrame(frame);
        },
        onDone: (done) => {
          if (this.timelines.get(done.sessionId) === done) this.timelines.delete(done.sessionId);
        },
      },
      pressedAt
    );
    // A rewrite records an instruction, never words into the draft, so it
    // leaves no summary: its counts would read as a dictation that lost its
    // text. Disposed, its timeline takes every mark as a no-op.
    if (target.rewrite) timeline.dispose();
    else this.timelines.set(sessionId, timeline);
    // Consumed: a target is reused by later starts (a microphone switch, a
    // locked dictation), and only the one that reopened the wait says so.
    if (this.reopeningStarts.delete(target)) timeline.noteReopenedSend();
    return timeline;
  }

  /**
   * A dictation started in a draft whose send was waiting, and called that
   * send off (#15703): the session's summary says so, so a prompt built from
   * two dictations reads differently from two prompts. Given the armed target
   * when the key's press did it, since its session isn't open yet, or the
   * session when one began without a press.
   */
  noteSendReopened(by: { target: VoiceRecordingTarget } | { sessionId: string }): void {
    if ("target" in by) this.reopeningStarts.add(by.target);
    else this.timelines.get(by.sessionId)?.noteReopenedSend();
  }

  private releasePendingCapture(): void {
    const pending = this.pendingCapture;
    if (!pending) return;
    this.pendingCapture = null;
    pending.queue = null;
    this.cleanupCaptureResources(pending);
  }

  /**
   * A stop the user asked for: a push-to-talk release, a second press, the
   * shortcut. A start whose capture is attached may hold speech in its queue,
   * so the stop waits for that audio to be sent rather than discarding it
   * (#14604). Escape, a closed panel and teardown end the start outright.
   */
  private requestUserStop(reason: VoiceStopReason = "user"): Promise<void> {
    this.clearCancelConfirm();
    if (this.deferStopToStartup(reason)) return Promise.resolve();
    const { status, pendingTarget } = useVoiceRecordingStore.getState();
    if ((pendingTarget || status === "arming") && !this.stream) {
      this.cancelArming(reason);
      return Promise.resolve();
    }
    return this.stop("Dictation stopped.", { preserveLiveText: true, reason });
  }

  /**
   * A stop made with the dictation key, here or from another view (#14791). It
   * ends the session as any of the user's stops does, then takes the person
   * back to the dictation: its pane comes forward with the keyboard in its
   * composer and the caret after the words dictated. What it goes back to is
   * read first, since the stop clears it.
   */
  private stopWithKey(reason: VoiceStopReason, pressedHere: boolean): Promise<void> {
    const { activeTarget, pendingTarget, status, panelBuffers } = useVoiceRecordingStore.getState();
    const startup = this.liveStartup();
    const target = startup?.target ?? activeTarget ?? pendingTarget;
    // Only a session that has begun has words to go after: a start's buffer
    // still names the last session's, and parking the caret there would move
    // where its queued words land.
    const sessionId =
      !startup && activeTarget && target === activeTarget && isActiveVoiceSession(status)
        ? (panelBuffers[activeTarget.panelId]?.dictationSessionId ?? null)
        : null;
    const back = target ? beginDictationReturn(target.panelId, { pressedHere }) : null;
    const stopping = this.requestUserStop(reason);
    if (target && back) {
      this.revealTarget(
        () => target,
        () => back.focus(() => afterDictatedWords(target, sessionId)),
        back.isCurrent
      );
    }
    return stopping;
  }

  /** Hand the press that is down right now to the recording it started. */
  private claimHeldPress(): void {
    if (this.heldPress) this.heldPress.claimed = true;
    // Stamped either way: the press on record may be an older one whose keyup
    // macOS swallowed, with this start's keydown still to arrive.
    this.claimedAt = performance.now();
  }

  /** Forget the press that is down and any claim waiting for its keydown. */
  private dropHeldPress(): void {
    this.heldPress = null;
    this.claimedAt = null;
  }

  // Local audio, not transcripts: a session still draining can deliver its
  // text after the next press has started.
  private noteHeldPressAudio(stats: PcmChunkStats): void {
    if (this.heldPress?.claimed && isSpeechLevel(stats)) this.heldPress.speechChunks++;
  }

  /**
   * The voice shortcut came back up. Push-to-talk always stops. Tap-or-hold
   * stops only a hold that heard speech: a quick tap, or a thumb that lingers
   * on Cmd before anything was said, leaves the recording running until the
   * next press.
   */
  private releaseHeldPress(reason: "key_release" | "window_blur"): void {
    const press = this.heldPress;
    this.heldPress = null;
    if (!press?.claimed) return;
    if (this.recordingMode === "tap-or-hold") {
      const heldMs = performance.now() - press.pressedAt;
      const heardSpeech = press.speechChunks >= VoiceRecordingService.HOLD_SPEECH_CHUNKS;
      if (heldMs <= VoiceRecordingService.HOLD_THRESHOLD_MS || !heardSpeech) return;
    } else if (this.recordingMode !== "push-to-talk") {
      return;
    }
    // Letting go of the key is a stop made with it; a window losing focus isn't.
    void (reason === "key_release" ? this.stopWithKey(reason, true) : this.requestUserStop(reason));
  }

  private liveStartup(): StartupAttempt | null {
    const startup = this.startup;
    return startup && !this.isStartRequestStale(startup.requestId) ? startup : null;
  }

  /**
   * Hand a stop to the start that is attached but hasn't sent its audio yet.
   * Nothing said after the stop is taken, and the session stops once the
   * queue is sent. The microphone stays open until then so a press on the same
   * target can resume it. False when there is no such start.
   */
  private deferStopToStartup(reason: VoiceStopReason): boolean {
    const startup = this.liveStartup();
    if (!startup) return false;
    this.heldPress = null;
    if (startup.stopAfterStart) return true;
    startup.stopAfterStart = true;
    startup.stopReason = reason;
    // The stop is the user's from now, though it runs once the queue is sent.
    startup.capture.timeline.mark("stopRequested");
    const { capture } = startup;
    capture.frozen = true;
    if (this.workletNode === capture.workletNode) this.clearMicSilenceTimer();
    logDebug(`${LOG_PREFIX} Stop requested during startup, keeping queued audio`, {
      chunks: capture.queue?.length ?? 0,
    });
    return true;
  }

  /**
   * A press on the target of a start the user already stopped, before its
   * queued speech was sent: keep recording into that start rather than
   * swallowing the press or replacing it and losing that speech.
   */
  private resumeReleasedStartup(target: VoiceRecordingTarget): boolean {
    const startup = this.liveStartup();
    if (!startup?.stopAfterStart || startup.target.panelId !== target.panelId) return false;
    startup.stopAfterStart = false;
    startup.capture.frozen = false;
    startup.capture.timeline.unmark("stopRequested");
    if (
      this.workletNode === startup.capture.workletNode &&
      useVoiceRecordingStore.getState().micSignal === "pending"
    ) {
      this.startMicSilenceTimer(this.generation, startup.requestId);
    }
    logDebug(`${LOG_PREFIX} Press resumed a stopped start`);
    return true;
  }

  private enqueueCapturedChunk(capture: CaptureAttempt, chunk: ArrayBuffer): void {
    const queue = capture.queue;
    if (!queue) return;
    queue.push(chunk);
    if (queue.length > MAX_QUEUED_CHUNKS) {
      queue.shift();
      capture.timeline.addDroppedQueued(1);
      if (++capture.droppedChunks === 1) {
        logWarn(`${LOG_PREFIX} Startup audio queue full, dropping oldest audio`);
      }
    }
  }

  private settingsAction(): NotificationAction {
    return {
      label: "Open voice settings",
      actionId: "app.settings.openTab",
      actionArgs: { tab: "voice" },
      onClick: () => this.openVoiceSettings(),
    };
  }

  private micSettingsAction(): NotificationAction {
    return {
      label: "Open microphone settings",
      onClick: () => {
        safeFireAndForget(window.electron.voiceInput.openMicSettings(), {
          context: "Opening OS microphone settings",
        });
      },
    };
  }

  private retryAction(retry: () => void): NotificationAction {
    return { label: "Retry", onClick: retry };
  }

  /** Every start failure surfaces here: one toast, one recovery action that fits the cause. */
  private reportStartFailure(title: string, message: string, action?: NotificationAction): void {
    const payload = { type: "error" as const, title, message };
    if (action) {
      notify({ ...payload, action });
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify(payload);
  }

  private openVoiceSettings(): void {
    safeFireAndForget(
      import("@/services/ActionService").then(({ actionService }) =>
        actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" })
      ),
      { context: "Opening voice settings" }
    );
  }

  /**
   * Roll the store off the "arming" status when a `start()` call has set
   * an error and is about to return. Without this, the store would stay
   * `{ status: "arming", activeTarget: T }` indefinitely — the toolbar and
   * panel border would keep showing the pre-recording cue with no mic to
   * back it up. A failed retarget also ends the session it was replacing:
   * the store is about to report an error with no target, and that session's
   * microphone must not keep recording behind it.
   */
  private async failArming(target: VoiceRecordingTarget): Promise<void> {
    await this.rollBackArming();
    // A push-to-talk start fails before any target is armed, so the error mark
    // is pinned to the panel that asked rather than read off the store.
    if (useVoiceRecordingStore.getState().status === "error") {
      useVoiceRecordingStore.getState().setErrorPanelId(target.panelId);
    }
  }

  private async rollBackArming(): Promise<void> {
    useVoiceRecordingStore.getState().clearPendingTarget();
    if (this.stream) {
      await this.stop(undefined, {
        nextStatus: "error",
        announce: false,
        preservePendingStart: true,
        reason: "retarget",
      });
      return;
    }
    // A stop still draining would otherwise finish afterwards and overwrite
    // the error with "idle".
    if (this.stopPromise) await this.stopPromise;
    releaseActiveVoiceAnchors();
    useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
  }

  async start(target: VoiceRecordingTarget): Promise<void> {
    this.initialize();
    const driven = drivenElsewhereFor(target.projectId);
    if (driven) {
      // A caller may have armed it already.
      this.cancelArming("lease_lost");
      this.reportDrivenStart(driven);
      return;
    }
    this.releasePendingCapture();
    // A newer start in this view replaces one still under way, and a send the
    // dictation still finishing lands isn't the user's last word any more.
    this.attemptTimeline?.finish("retarget");
    this.stopTakesSpokenSend = false;
    const startRequestId = ++this.startRequestId;
    const sessionId = crypto.randomUUID();
    const timeline = this.openTimeline(sessionId, target);
    this.attemptTimeline = timeline;
    // The caller showed the arming cue (or the queued-start cue) just before.
    if (useVoiceRecordingStore.getState().pendingTarget?.panelId === target.panelId) {
      timeline.markNextFrame("cue");
    }
    try {
      await this.runStart(target, startRequestId, sessionId, timeline);
    } finally {
      // Neither promoted nor cancelled: the start gave up on its own.
      if (this.attemptTimeline === timeline) {
        this.attemptTimeline = null;
        timeline.finish("start_failed");
      }
    }
  }

  private async runStart(
    target: VoiceRecordingTarget,
    startRequestId: number,
    sessionId: string,
    timeline: VoiceSessionTimeline
  ): Promise<void> {
    // toggle() reaches here with no await after the hotkey/click, so start()
    // entry stands in for the gesture in these step logs; the session summary
    // goes back to the key press itself. Renderer-local clock only — main's
    // timings use their own origin.
    const startedAt = performance.now();
    const logStep: StartStepLogger = (step, details) => {
      try {
        logInfo(`${LOG_PREFIX} Start step`, {
          startRequestId,
          sessionId,
          step,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...details,
        });
      } catch {
        // Diagnostics must never abort start() or drop a chunk.
      }
    };
    logDebug(`${LOG_PREFIX} start() called`, {
      panelId: target.panelId,
      generation: this.generation,
      startRequestId,
    });
    logStep("start");

    // The settings read and the permission-status read are independent IPCs,
    // so both go out together rather than paying two round trips in series.
    // The permission result is settled into a value so an early return on the
    // settings side never leaves a rejection unhandled.
    const micStatusPromise = window.electron.voiceInput.checkMicPermission().then(
      (status) => {
        logStep("permission_check", { micStatus: status });
        return { ok: true as const, status };
      },
      (error: unknown) => ({ ok: false as const, error })
    );
    const isConfigured = await this.refreshConfiguration().catch(() => false);
    logStep("settings", { configured: isConfigured });
    if (this.transcriptionProvider) timeline.setProvider(this.transcriptionProvider);
    if (!isConfigured || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Not configured, aborting start`);
      if (!this.isStartRequestStale(startRequestId)) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "renderer_error",
          message: "Voice input is not configured.",
        });
        useVoiceRecordingStore
          .getState()
          .announce("Voice dictation is not configured. Open Voice settings to continue.");
        await this.failArming(target);
        this.openVoiceSettings();
      }
      return;
    }

    // Check and request OS-level microphone permission (macOS requires this
    // from the main process before getUserMedia will succeed in the renderer).
    // A rejection (main-process crash, channel teardown) must not leak past
    // start() and leave the store armed forever.
    const micStatusResult = await micStatusPromise;
    if (!micStatusResult.ok) {
      logError(
        `${LOG_PREFIX} checkMicPermission IPC rejected`,
        undefined,
        voiceErrorLogFields(micStatusResult.error)
      );
      if (!this.isStartRequestStale(startRequestId)) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "mic_permission_check_failed",
          message: "Could not check microphone permission. Try again.",
        });
        this.reportStartFailure(
          "Dictation didn't start",
          "Could not check microphone permission.",
          this.retryAction(() => void this.start(target))
        );
        await this.failArming(target);
      }
      return;
    }
    if (this.isStartRequestStale(startRequestId)) {
      return;
    }
    const micStatus = micStatusResult.status;
    logDebug(`${LOG_PREFIX} Microphone permission status`, { micStatus });

    if (micStatus === "denied" || micStatus === "restricted") {
      const message = "Microphone permission denied. Enable it in System Settings and try again.";
      logError(`${LOG_PREFIX} Microphone permission denied at OS level`, { micStatus });
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
      useVoiceRecordingStore.getState().announce(message);
      this.reportStartFailure("Microphone blocked", message, this.micSettingsAction());
      await this.failArming(target);
      return;
    }

    if (micStatus === "not-determined") {
      logDebug(`${LOG_PREFIX} Running native microphone permission preflight`);
      // Only macOS can answer this natively; Windows/Linux resolve `true` to mean
      // "clear to attempt capture", so a `false` here is a genuine macOS denial.
      let canAttemptCapture: boolean;
      try {
        canAttemptCapture = await window.electron.voiceInput.requestMicPermission();
      } catch (err) {
        logError(
          `${LOG_PREFIX} requestMicPermission IPC rejected`,
          undefined,
          voiceErrorLogFields(err)
        );
        if (!this.isStartRequestStale(startRequestId)) {
          useVoiceRecordingStore.getState().setLastError({
            severity: "fatal",
            code: "mic_permission_request_failed",
            message: "Could not request microphone permission. Try again.",
          });
          this.reportStartFailure(
            "Dictation didn't start",
            "Could not request microphone permission.",
            this.retryAction(() => void this.start(target))
          );
          await this.failArming(target);
        }
        return;
      }
      if (this.isStartRequestStale(startRequestId)) {
        return;
      }
      logDebug(`${LOG_PREFIX} Native microphone preflight result`, { canAttemptCapture });
      logStep("permission_request", { canAttemptCapture });
      if (!canAttemptCapture) {
        const message = "Microphone permission denied. Enable it in System Settings and try again.";
        useVoiceRecordingStore
          .getState()
          .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
        useVoiceRecordingStore.getState().announce(message);
        this.reportStartFailure("Microphone blocked", message, this.micSettingsAction());
        await this.failArming(target);
        return;
      }
    }

    // Acquire the AudioContext BEFORE opening the microphone. Constructing one
    // on the default sink resolves the output device with a synchronous IPC,
    // and Chromium only caches that answer for a few seconds. Constructed after
    // getUserMedia, a cache miss queues behind the audio service bringing up
    // the just-opened input stream and freezes the renderer for ~650ms on
    // macOS — with the recording indicator already committed but unpainted.
    // Done first, the lookup lands on an idle audio service.
    let audio: WarmAudio;
    try {
      audio = this.acquireWarmAudio(logStep);
    } catch (error) {
      logError(`${LOG_PREFIX} Failed to create the AudioContext`, undefined, {
        ...voiceErrorLogFields(error),
      });
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Failed to load the audio processor.",
      });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to initialize.");
      this.reportStartFailure(
        "Dictation didn't start",
        "Failed to load the audio processor.",
        this.retryAction(() => void this.start(target))
      );
      await this.failArming(target);
      return;
    }
    const audioContext = audio.context;
    const capture: CaptureAttempt = {
      target,
      audio,
      stopObservingContext: this.observeAudioContextState(audioContext, logStep),
      stream: null,
      source: null,
      workletNode: null,
      queue: [],
      droppedChunks: 0,
      timeline,
      deviceId: null,
      deviceLabel: null,
      substituted: false,
      chosenLabel: null,
      lost: false,
      frozen: false,
    };
    audio.users.add(capture);
    this.pendingCapture = capture;
    let startup: StartupAttempt | null = null;
    // Owned by the attempt until promotion, so a previous session's stop can't
    // flush this attempt's window as its own.
    const openingAudio: OpeningAudio = { startRequestId, chunks: [], logged: false };
    // An attempt no longer pending was already released by a cancel or
    // supersede; the stream is stopped directly in case it arrived afterwards.
    const abandonCapture = (stream?: MediaStream) => {
      if (startup && this.startup === startup) this.startup = null;
      if (this.pendingCapture === capture) this.releasePendingCapture();
      this.flushOpeningAudio(openingAudio);
      if (stream) this.stopStreamTracks(stream);
    };

    // Build the rest of the graph while the microphone is still opening, so it
    // is ready to attach the moment the stream arrives. Observed immediately so
    // a bail before it is awaited can't surface as an unhandled rejection.
    const graphReady = (async () => {
      this.startKeepAlive(audio);
      // A reused context is suspended, or still has a release's suspend
      // queued, so the resume is queued behind it whatever `state` says.
      const resumed = this.queueWarmAudioTransition(audio, () => audioContext.resume()).then(() =>
        logStep("audio_context_resume", { state: audioContext.state })
      );
      const cached = audio.workletReady !== null;
      await Promise.all([
        resumed,
        this.loadWorklet(audio).then(() => logStep("worklet_load", { cached })),
      ]);
    })().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );

    // Acquire microphone stream. On macOS the preflight above already settled
    // permission; on Windows/Linux this call IS the permission gate, so a denial
    // arrives here as NotAllowedError rather than from the preflight.
    logDebug(`${LOG_PREFIX} Requesting microphone access`);
    let opened: OpenedMic;
    // Snapshot: a settings change while the mic opens mustn't read as a fallback.
    const requestedDeviceId = this.selectedDeviceId;
    const requestedDeviceLabel = this.selectedDeviceLabel;
    try {
      opened = await openChosenMic(requestedDeviceId, {
        canFallBack: () => !this.isStartRequestStale(startRequestId),
        chosenLabel: requestedDeviceLabel,
      });
    } catch (error) {
      abandonCapture();
      const message = isMicPermissionDenial(error)
        ? "Microphone permission denied. Enable it in System Settings and try again."
        : "Could not access the microphone.";
      logError(`${LOG_PREFIX} getUserMedia failed`, undefined, {
        ...voiceErrorLogFields(error),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      if (!this.isStartRequestStale(startRequestId)) {
        const micCode = isMicPermissionDenial(error)
          ? "mic_permission_denied"
          : "mic_access_failed";
        useVoiceRecordingStore
          .getState()
          .setLastError({ severity: "fatal", code: micCode, message });
        useVoiceRecordingStore.getState().announce(message);
        this.reportStartFailure(
          micCode === "mic_permission_denied" ? "Microphone blocked" : "Microphone unavailable",
          micCode === "mic_permission_denied"
            ? message
            : "Could not access the microphone. It may be in use by another app.",
          micCode === "mic_permission_denied"
            ? this.micSettingsAction()
            : this.retryAction(() => void this.start(target))
        );
        await this.failArming(target);
      }
      return;
    }
    const stream = opened.stream;
    if (this.pendingCapture === capture) capture.stream = stream;
    if (opened.chosenFailure !== null) {
      logWarn(
        `${LOG_PREFIX} Chosen microphone failed to open; used the system default`,
        voiceErrorLogFields(opened.chosenFailure)
      );
    }

    // Log which mic and capture settings the OS handed us — a wrong/dead device
    // or unexpected sample rate is a real failure mode. Kept out of the
    // getUserMedia try block and fully guarded: diagnostics must never be able
    // to abort start().
    try {
      const audioTracks = stream.getAudioTracks();
      logInfo(`${LOG_PREFIX} Microphone access granted`, {
        trackCount: audioTracks.length,
        devices: audioTracks.map((track) => {
          const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
          return {
            hasLabel: Boolean(track.label),
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
            // `deviceId` is load-bearing for this subsystem — it's how we tell
            // "system default" from a specific device (see issue #7902).
            deviceId: settings.deviceId,
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl,
          };
        }),
      });
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not read microphone track settings`, voiceErrorLogFields(err));
    }
    // Which mic opened, for the pane: the system default stands in whenever
    // the chosen one is gone or won't open.
    capture.deviceLabel = opened.label;
    capture.deviceId = opened.deviceId;
    capture.substituted = opened.substituted;
    capture.chosenLabel = stripPseudoDevicePrefix(requestedDeviceLabel) || null;
    if (opened.relocatedId) void this.rememberRelocatedMic(requestedDeviceId, opened.relocatedId);
    if (opened.substituted) {
      logWarn(`${LOG_PREFIX} Microphone device mismatch`, {
        requested: requestedDeviceId,
        actual: opened.deviceId,
      });
    }
    logStep("get_user_media");
    this.observeTrackState(stream, logStep, () => this.handleTrackEnded(capture));

    if (this.isStartRequestStale(startRequestId)) {
      abandonCapture(stream);
      return;
    }

    const failMicLost = async () => {
      abandonCapture(stream);
      logWarn(`${LOG_PREFIX} Microphone lost before the session began`);
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "mic_lost",
        message: "The microphone was disconnected.",
      });
      useVoiceRecordingStore
        .getState()
        .setMicNotice({ kind: "lost", target, deviceLabel: capture.deviceLabel });
      useVoiceRecordingStore
        .getState()
        .announce("Dictation didn't start because the microphone was disconnected.");
      await this.failArming(target);
    };
    const isCaptureLost = () =>
      capture.lost ||
      (typeof stream.getAudioTracks === "function" &&
        stream.getAudioTracks().some((track) => track.readyState === "ended"));

    const graphResult = await graphReady;
    if (this.isStartRequestStale(startRequestId)) {
      abandonCapture(stream);
      return;
    }
    if (isCaptureLost()) {
      await failMicLost();
      return;
    }
    const failCaptureSetup = async (error: unknown) => {
      abandonCapture(stream);
      logError(
        `${LOG_PREFIX} Failed to set up the audio graph`,
        undefined,
        voiceErrorLogFields(error)
      );
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Failed to load the audio processor.",
      });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to initialize.");
      this.reportStartFailure(
        "Dictation didn't start",
        "Failed to load the audio processor.",
        this.retryAction(() => void this.start(target))
      );
      await this.failArming(target);
    };
    if (!graphResult.ok) {
      await failCaptureSetup(graphResult.error);
      return;
    }
    logDebug(`${LOG_PREFIX} pcm-processor worklet loaded`);

    // Attach capture now, ahead of any retarget drain and the backend start.
    // Until the session is promoted, chunks only land in this attempt's queue:
    // they must not reach the previous session's send path or its meters.
    let workletNode: AudioWorkletNode;
    let sessionGeneration: number | null = null;
    let arrivedChunks = 0;
    let firstNonZeroChunk = 0;
    let firstSignalChunk = 0;
    let firstLiveChunk = 0;
    const observeArrivingChunk = (data: ArrayBuffer): PcmChunkStats | null => {
      try {
        arrivedChunks++;
        const stats = measurePcm16Chunk(new Int16Array(data));
        if (arrivedChunks === 1) {
          logStep("first_chunk", { samples: stats.samples, held: capture.queue !== null });
        }
        // Steady chunks don't prove a live mic: exact zeros come from a muted
        // track or Chromium zero-filling an underrunning input FIFO. Separate
        // "any sample moved" from "above the signal floor".
        if (!firstNonZeroChunk && stats.zeroFraction < 1 && stats.samples > 0) {
          firstNonZeroChunk = arrivedChunks;
          logStep("first_nonzero_chunk", {
            chunk: arrivedChunks,
            peak: Number(stats.peak.toFixed(4)),
          });
        }
        if (!firstSignalChunk && hasRealSignal(stats)) {
          firstSignalChunk = arrivedChunks;
          timeline.noteSignal();
          logStep("first_signal_chunk", {
            chunk: arrivedChunks,
            peak: Number(stats.peak.toFixed(4)),
          });
        }
        // On arrival, held or not: a mic that came alive while a previous
        // session drained was live from here, not from promotion.
        if (!firstLiveChunk && isMicLive(stats)) {
          firstLiveChunk = arrivedChunks;
          timeline.mark("micLive");
        }
        if (isSpeechLevel(stats)) timeline.noteSpeech();
        if (!this.isStartRequestStale(startRequestId)) this.noteHeldPressAudio(stats);
        if (!openingAudio.logged) {
          openingAudio.chunks.push(stats);
          if (openingAudio.chunks.length >= OPENING_CHUNK_WINDOW) {
            this.flushOpeningAudio(openingAudio);
          }
        }
        return stats;
      } catch {
        // Diagnostics must never drop a chunk.
        return null;
      }
    };
    try {
      const source = audioContext.createMediaStreamSource(stream);
      capture.source = source;
      workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      capture.workletNode = workletNode;
      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: "flushed" }>) => {
        if (!(event.data instanceof ArrayBuffer)) {
          if (event.data?.type === "flushed" && this.pendingWorkletFlush?.node === workletNode) {
            this.pendingWorkletFlush.resolve();
          }
          return;
        }
        if (sessionGeneration !== null && this.generation !== sessionGeneration) return;
        if (capture.frozen) return;
        // Measured on arrival, held or not, so the timings show when audio
        // actually reached the renderer. Read before sendAudioChunk() hands
        // the buffer to IPC.
        const stats = observeArrivingChunk(event.data);
        if (sessionGeneration === null) {
          this.enqueueCapturedChunk(capture, event.data);
          return;
        }
        this.meterAudioChunk(event.data, stats ?? undefined);
        // Held chunks count too: the user may be speaking before the backend
        // is connected, and the cue should follow the mic, not the socket.
        if (
          stats &&
          isMicLive(stats) &&
          !this.isStartRequestStale(startRequestId) &&
          isVoiceMicPending(useVoiceRecordingStore.getState())
        ) {
          this.markMicLive(target, arrivedChunks);
        }
        if (capture.queue) {
          this.enqueueCapturedChunk(capture, event.data);
        } else {
          window.electron.voiceInput.sendAudioChunk(sessionId, event.data);
        }
      };
      source.connect(workletNode);
    } catch (error) {
      await failCaptureSetup(error);
      return;
    }
    startup = {
      requestId: startRequestId,
      target,
      capture,
      stopAfterStart: false,
      stopReason: "user",
    };
    this.startup = startup;
    logDebug(`${LOG_PREFIX} Eager audio capture started`);
    logStep("source_attach");
    const captureAttachedAt = performance.now();
    let micSilenceGraceMs = VoiceRecordingService.MIC_SILENCE_GRACE_MS;

    // Only an actually-started session (open mic stream) needs to be torn
    // down here. `this.stream` is the canonical "audio is open" flag and is
    // independent of store status — using store.activeTarget here would
    // false-positive during the arming window (we seeded it ourselves) and
    // status alone would miss a cross-panel switch where the new "arming"
    // status has already overwritten the prior session's "recording". A stop
    // already draining is joined too, so the new session never begins under it.
    if (this.stream || this.stopPromise) {
      logDebug(`${LOG_PREFIX} Stopping existing session before starting new one`);
      await this.stop(undefined, {
        preserveLiveText: true,
        announce: false,
        preservePendingStart: true,
        skipCorrection: true,
        reason: "retarget",
      });
      logStep("previous_session_stop");
      if (this.isStartRequestStale(startRequestId)) {
        abandonCapture(stream);
        return;
      }
      if (isCaptureLost()) {
        await failMicLost();
        return;
      }
      // The new mic has been capturing through the drain, so that time counts
      // against its grace window.
      micSilenceGraceMs = Math.max(0, micSilenceGraceMs - (performance.now() - captureAttachedAt));
    }

    const generation = ++this.generation;
    logDebug(`${LOG_PREFIX} Beginning session`, { generation });
    this.pauseStartedAt = 0;
    this.totalPausedMs = 0;
    this.clearPauseTimeout();
    useVoiceRecordingStore.getState().beginSession(target, sessionId);
    // beginSession resets the panel's buffer; a passage still being corrected
    // there keeps its underline.
    if (this.hasPendingCorrection(target.panelId)) this.syncCorrectionRange(target.panelId);

    // Promote the attempt to the session. From here stop() owns its teardown,
    // and its summary's end.
    if (this.pendingCapture === capture) this.pendingCapture = null;
    if (this.attemptTimeline === timeline) this.attemptTimeline = null;
    // The connecting cue, for a start that showed none before it.
    timeline.markNextFrame("cue");
    capture.stream = stream;
    this.sessionCapture = capture;
    this.stream = stream;
    this.workletNode = workletNode;
    this.sessionId = sessionId;
    this.sessionDropsHesitations = this.dropHesitations;
    sessionGeneration = generation;
    logInfo(`${LOG_PREFIX} AudioContext attached`, {
      sink: audio.sink,
      requestedSampleRate: 24000,
      actualSampleRate: audioContext.sampleRate,
      state: audioContext.state,
      baseLatency: audioContext.baseLatency,
    });
    if (!openingAudio.logged) this.openingAudio = openingAudio;

    this.sessionPeakRms = 0;
    this.sessionRmsSum = 0;
    this.sessionChunkCount = 0;
    for (const chunk of capture.queue ?? []) {
      this.meterAudioChunk(chunk);
    }

    // The "Dictation started" announcement waits for real audio (markMicLive);
    // announcing here would tell the user to speak into a mic still delivering
    // zeros.
    useVoiceRecordingStore.getState().setMicDeviceLabel(capture.deviceLabel);
    this.displacedFallbackNotice = null;
    if (capture.substituted) {
      useVoiceRecordingStore.getState().setMicNotice({
        kind: "fallback",
        target,
        deviceLabel: capture.deviceLabel,
        chosenLabel: capture.chosenLabel,
      });
    }

    this.sessionStartedAt = Date.now();
    this.sessionProvider = this.transcriptionProvider;
    this.sessionClockRunning = true;
    this.startElapsedTimer();
    this.startIdleTimer();
    this.micCaptureAttachedAt = captureAttachedAt;
    // Real audio that arrived while a previous session drained already counts.
    // A capture the user already stopped expects no more audio to judge by.
    if (firstLiveChunk) {
      this.markMicLive(target, firstLiveChunk);
    } else if (!capture.frozen) {
      this.startMicSilenceTimer(generation, startRequestId, micSilenceGraceMs);
    }

    // The start request goes out before any held chunk: main arms its
    // pre-start buffer for this session synchronously on receipt, and a send
    // issued after the invoke reaches main after it. From here every chunk
    // streams to main, which holds it until the provider exists, so a stop
    // before the backend is ready still has the audio to transcribe.
    logDebug(`${LOG_PREFIX} Calling voiceInput.start() IPC`);
    timeline.expectReport();
    const workspaceName = viewWorkspaceName();
    const started = window.electron.voiceInput
      .start(sessionId, {
        ...voiceContext(target),
        ...(target.rewrite ? { intent: "rewrite" as const } : {}),
        ...(workspaceName ? { workspaceName } : {}),
      })
      .then(
        (outcome) =>
          outcome.status === "started"
            ? { ok: true as const }
            : {
                ok: false as const,
                error: outcome.status === "failed" ? outcome.error : "Voice session superseded",
              },
        (error: unknown) => ({
          ok: false as const,
          error: formatErrorMessage(error, "Voice input failed to start."),
        })
      );
    // Marked apart from the await below: a stop held during startup returns
    // before it, and a provider stopped while connecting becomes ready without
    // a "recording" status.
    void started.then((outcome) => {
      if (outcome.ok) timeline.mark("socketReady");
    });

    // Flush synchronously, oldest first, so no live chunk can interleave.
    const queued = capture.queue ?? [];
    capture.queue = null;
    for (const chunk of queued) {
      window.electron.voiceInput.sendAudioChunk(sessionId, chunk);
    }
    logDebug(`${LOG_PREFIX} Flushed startup audio`, {
      chunks: queued.length,
      droppedChunks: capture.droppedChunks,
    });
    logStep("startup_audio_flush", {
      chunks: queued.length,
      droppedChunks: capture.droppedChunks,
    });
    if (this.startup === startup) this.startup = null;

    // Stopped while its audio was still queued: main holds that speech now, so
    // the session drains like any stop that lands before the backend is ready.
    if (startup.stopAfterStart) {
      logDebug(`${LOG_PREFIX} Running the stop requested during startup`);
      await this.stop("Dictation stopped.", {
        preserveLiveText: true,
        reason: startup.stopReason,
      });
      return;
    }

    const result = await started;
    logDebug(`${LOG_PREFIX} voiceInput.start() returned`, { ok: result.ok });
    logStep("backend_start", { ok: result.ok });

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after IPC start`);
      this.clearMicSilenceTimerFor(generation, startRequestId);
      // A stop in progress owns the promoted capture, and may still be draining
      // the worklet through the handler this cleanup would detach. It also
      // closes the opening-audio window once the tail is in.
      if (!this.stopPromise) {
        // No stop owns it, so the newer start that made it stale ends it here.
        timeline.finish("retarget");
        this.flushOpeningAudio(openingAudio);
        this.cleanupCaptureResources(capture);
      }
      return;
    }

    if (!result.ok) {
      logError(`${LOG_PREFIX} Backend start failed`);
      // Main has already ended it: there is nothing left to stop remotely.
      if (this.sessionId === sessionId) this.sessionId = null;
      timeline.finish("start_failed");
      this.flushOpeningAudio(openingAudio);
      this.clearTimers();
      this.cleanupAudioCapture();
      // A newer start may have taken over while the teardown awaited.
      if (this.generation !== generation || this.isStartRequestStale(startRequestId)) return;
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "backend_start_failed", message: result.error });
      releaseActiveVoiceAnchors();
      useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to start.");
      this.reportStartFailure("Dictation didn't start", result.error, this.settingsAction());
      return;
    }

    // Backend is connected — status transitions to "recording" via the onStatus listener.
    logDebug(`${LOG_PREFIX} Recording started successfully`);
  }

  private meterAudioChunk(
    data: ArrayBuffer,
    stats: PcmChunkStats = measurePcm16Chunk(new Int16Array(data))
  ): void {
    this.sessionChunkCount++;
    const chunkCount = this.sessionChunkCount;

    // RMS audio level from PCM16 samples for the UI glow.
    const rms = stats.rms;
    this.sessionPeakRms = Math.max(this.sessionPeakRms, rms);
    this.sessionRmsSum += rms;
    this.pendingLevel = Math.min(1, rms * 6);

    if (chunkCount <= 3 || chunkCount % 100 === 0) {
      // Include RMS stats so a captured log can distinguish "mic was silent"
      // (peak/avg near 0) from "user spoke but no transcription came back".
      logDebug(`${LOG_PREFIX} Audio chunk #${chunkCount}`, {
        bytes: data.byteLength,
        rms: Number(rms.toFixed(4)),
        peakRms: Number(this.sessionPeakRms.toFixed(4)),
        avgRms: Number((this.sessionRmsSum / chunkCount).toFixed(4)),
      });
    }

    if (this.levelRaf === null) {
      this.levelRaf = requestAnimationFrame(() => {
        this.levelRaf = null;
        useVoiceRecordingStore.getState().setAudioLevel(this.pendingLevel);
      });
    }
  }

  async stop(
    announcement = "Dictation stopped.",
    options: {
      skipRemoteStop?: boolean;
      preserveLiveText?: boolean;
      nextStatus?: "idle" | "error";
      announce?: boolean;
      preservePendingStart?: boolean;
      /** Skip the post-stop whole-passage AI cleanup pass (e.g. when stopping to start a new session). */
      skipCorrection?: boolean;
      /** The caller already played its own cue for this stop. */
      silentCue?: boolean;
      /** Why, for the session summary; a joined stop keeps the first one's. */
      reason?: VoiceStopReason;
    } = {}
  ): Promise<void> {
    const reason = options.reason ?? "user";
    this.clearCancelConfirm();
    if (this.stopPromise) {
      // Whatever joined wants something of this stop besides an end of speech:
      // a send, a teardown, a retarget. A "send it" still to land doesn't send.
      this.stopTakesSpokenSend = false;
      // Joining a stop already in flight — typically a retarget's teardown,
      // which runs with preservePendingStart so its own start can follow. An
      // explicit stop has to cancel that pending start too, or the recording
      // resumes on the new target once the drain finishes.
      if (!options.preservePendingStart) {
        this.invalidatePendingStart(reason);
        this.heldPress = null;
      }
      await this.stopPromise;
      return;
    }

    this.stopTakesSpokenSend = reason === "key_release" || reason === "user";
    this.stopAnnounces = true;
    this.stopPromise = (async () => {
      this.initialize();
      const { skipRemoteStop = false, preserveLiveText = true, nextStatus = "idle" } = options;
      const shouldAnnounce = options.announce ?? true;

      // Clear any PTT key tracking — the keyup safety net should not fire stop
      // again on a session that's already winding down. A stop that makes way
      // for the next start leaves that start's held key alone.
      if (!options.preservePendingStart) {
        this.heldPress = null;
        this.invalidatePendingStart(reason);
      }

      const stopSessionId = this.sessionId;
      const stopTimeline = stopSessionId ? this.timelines.get(stopSessionId) : undefined;
      stopTimeline?.mark("stopRequested");
      const storeState = useVoiceRecordingStore.getState();
      const hasSession =
        storeState.activeTarget !== null || isActiveVoiceSession(storeState.status);
      // Captured before finishSession() clears activeTarget — used to kick off
      // the post-stop correction pass once the session has wound down. While a
      // retarget is still arming, activeTarget names the panel being switched
      // to, not the session this stop ends, so there's nothing to correct.
      const stoppedTarget = storeState.status === "arming" ? null : storeState.activeTarget;
      const stoppedSessionId = stoppedTarget
        ? (storeState.panelBuffers[stoppedTarget.panelId]?.dictationSessionId ?? null)
        : null;
      const correctionEnabled = storeState.correctionEnabled;
      const wasMicLive = storeState.micSignal === "live";

      logDebug(`${LOG_PREFIX} stop() called`, {
        announcement,
        hasSession,
        skipRemoteStop,
        nextStatus,
        currentStatus: storeState.status,
        hasActiveTarget: !!storeState.activeTarget,
      });

      this.clearTimers();
      // The drain's words are the stop-time pass's: no chunk is cut from them.
      this.resetChunking();
      if (!skipRemoteStop) {
        // Finishing from here: backend errors and start-up ticks that land
        // while the tail drains belong to the session being stopped.
        this.isStoppingSession = true;
        useVoiceRecordingStore.getState().setStatus("finishing");
        // Have the worklet hand over its partial chunk and forward every chunk
        // still in flight. The generation isn't bumped until after, so those
        // chunks still reach main ahead of the remote stop.
        await this.flushCapturedAudio();
      }

      // A session shorter than the opening window still reports what it had.
      if (this.openingAudio) this.flushOpeningAudio(this.openingAudio);

      // Session audio summary — a near-zero peak means the mic captured no
      // speech, which explains an empty transcript without it being a bug.
      if (this.sessionChunkCount > 0) {
        logInfo(`${LOG_PREFIX} Session audio summary`, {
          chunks: this.sessionChunkCount,
          peakRms: Number(this.sessionPeakRms.toFixed(4)),
          avgRms: Number((this.sessionRmsSum / this.sessionChunkCount).toFixed(4)),
          likelySilent: this.sessionPeakRms < 0.01,
        });
      } else {
        logWarn(`${LOG_PREFIX} Session produced zero audio chunks`);
      }

      // Stop audio capture — no new audio after this point.
      this.cleanupAudioCapture();
      this.generation++;

      // After capture closes, so the cue can't be recorded. A stop that makes
      // way for another session stays silent, and a failed one is cued by the
      // error transition.
      if (
        hasSession &&
        wasMicLive &&
        nextStatus === "idle" &&
        !options.preservePendingStart &&
        !options.skipCorrection &&
        !options.silentCue
      ) {
        this.playCue("dictation-stop");
      }

      if (!skipRemoteStop) {
        // Graceful stop: the IPC handler drains pending transcriptions and flushes
        // the paragraph buffer before resolving. Keep activeTarget alive so late
        // transcription and correction events are still applied to the correct panel.
        logDebug(`${LOG_PREFIX} Sending remote stop (graceful drain)`);
        // No promoted session means main never heard of one from this view.
        if (stopSessionId) {
          await window.electron.voiceInput.stop(stopSessionId).catch(() => null);
        }
      }

      let finished: FinishedTranscript | null = null;
      if (hasSession) {
        // Flush any remaining interim text (liveText) into the draft as a final
        // commit before finishSession clears it. In the ghost-widget flow the
        // doc carries no interim text, so without this flush a mid-utterance
        // stop would silently drop the partial transcription.
        let committedLiveText: string | undefined;
        if (preserveLiveText) {
          const currentTarget = useVoiceRecordingStore.getState().activeTarget;
          const rewrite = currentTarget?.rewrite;
          if (rewrite) {
            const remaining = useVoiceRecordingStore
              .getState()
              .panelBuffers[currentTarget.panelId]?.liveText.trim();
            if (remaining) rewrite.instruction.push(remaining);
          } else if (currentTarget) {
            const { panelId, projectId } = currentTarget;
            const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
            const preview = buffer?.liveText?.trim();
            const remaining =
              preview && this.sessionDropsHesitations ? stripHesitations(preview) : preview;
            committedLiveText = remaining;
            // Kept for Recent dictations either way; only a draft this view
            // still drives takes them.
            if (remaining && !isDraftDetached(buffer?.dictationSessionId)) {
              const { words } = writeVoiceWords(
                panelId,
                projectId,
                buffer?.dictationSessionId,
                remaining
              );
              // A session stopped mid-utterance may have no final; its learning
              // baseline still needs a start to follow.
              useVoiceRecordingStore.getState().setSessionDraftStart(panelId, words.from);
              stopTimeline?.addCommitted(remaining.length);
            }
          }
        }
        releaseActiveVoiceAnchors();
        useVoiceRecordingStore.getState().finishSession({
          preserveLiveText,
          nextStatus,
          ...(committedLiveText !== undefined ? { committedLiveText } : {}),
        });
        // Every ending keeps its words, not only a clean stop: an error, a
        // closed panel or a sleep are exactly when they need recovering. Read
        // by the session this stop began with, which a start racing the
        // teardown can't take the place of. A rewrite's spoken instruction
        // was never meant for a draft, so it isn't one to recover. Kept once
        // the heard-as rules below have had their say.
        if (stoppedTarget && !stoppedTarget.rewrite) {
          finished = takeFinishedTranscript(stoppedTarget, stoppedSessionId);
        }
        if (shouldAnnounce && this.stopAnnounces) {
          // A note still on the session's border goes with it: this would
          // cut one just heard off before the announcer reads it.
          const { scratchRefusal: refusal, fileReferenceNote } = useVoiceRecordingStore.getState();
          const note =
            refusal && refusal.panelId === stoppedTarget?.panelId
              ? SCRATCH_REFUSAL_STATUS[refusal.reason]
              : fileReferenceNote && fileReferenceNote.panelId === stoppedTarget?.panelId
                ? unresolvedFileReferencesStatus(fileReferenceNote.references)
                : null;
          useVoiceRecordingStore
            .getState()
            .announce(note ? `${announcement} ${note}` : announcement);
        }
      } else if (nextStatus === "idle") {
        useVoiceRecordingStore.getState().setStatus("idle");
      }

      this.isStoppingSession = false;
      if (this.sessionId === stopSessionId) this.sessionId = null;
      // Every word the transcription will give is in the draft by now.
      stopTimeline?.mark("settled");

      // Its draft went to another screen's driver: the words are kept as heard,
      // and nothing rewrites what is now the driver's text.
      const detached = isDraftDetached(stoppedSessionId);
      // Chunks cleaned while it ran are settled; what's left is the stop's.
      const cleanup = stoppedSessionId ? this.cleanups.get(stoppedSessionId) : undefined;
      if (cleanup) cleanup.stopped = true;
      const unclaimed = cleanup
        ? (utterance: DictationUtterance) => !cleanup.claimed.has(utterance.id)
        : undefined;
      // Each utterance met the heard-as rules as it landed; with the whole
      // dictation in, a phrase split across two of them is caught too. Every
      // stop that keeps the text gets this, whether or not correction runs.
      // A rewrite's instruction goes to the model as spoken. A chunk had its
      // own rerun before its cleanup, which nothing reruns over.
      if (stoppedTarget && !stoppedTarget.rewrite && this.heardAsRules && !detached) {
        const rewrites = [
          ...(cleanup?.rewrites ?? []),
          ...this.applyHeardAsRules(stoppedTarget, stoppedSessionId, this.heardAsRules, unclaimed),
        ];
        // The history holds what landed, and a cleanup only counts for it when
        // it covered the same words.
        if (finished && rewrites.length > 0) {
          finished = { ...finished, rawText: applyPassageRewrites(finished.rawText, rewrites) };
        }
      }
      if (finished) {
        keepRecentDictation({ ...finished, correctedText: null, endedAt: Date.now() });
      }

      // Whole-passage AI cleanup runs after a deliberate, graceful stop only —
      // not on error, cancel-to-restart, or backend-driven teardown. stop()
      // doesn't await it: the decoration shows progress, and a send waits for
      // it through waitForPendingCorrections(). It is registered before stop()
      // resolves, so a caller that awaited stop() can always see it.
      const graceful =
        !skipRemoteStop && nextStatus === "idle" && !options.skipCorrection && !detached;
      if (stoppedTarget?.rewrite) {
        if (graceful && !stoppedTarget.rewrite.cancelled) {
          this.runRewrite(stoppedTarget, stoppedTarget.rewrite);
        } else if (this.liveStartup()?.target.rewrite !== stoppedTarget.rewrite) {
          // A restart of the same rewrite (a microphone switch) keeps recording into it.
          stoppedTarget.rewrite.selection.release();
        }
      } else if (graceful && stoppedTarget) {
        // With correction off, the dictated text as it stands is the learning
        // baseline, and manual corrections to it can still be detected at send
        // time (#9749).
        this.finishDictationCleanup(
          stoppedTarget,
          stoppedSessionId,
          finished,
          stopTimeline ?? null,
          correctionEnabled
        );
      } else if (cleanup) {
        this.keepCleanedHistory(cleanup);
      }
      // After the correction is registered, so the summary waits for it.
      stopTimeline?.finish(reason);
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
      this.stopTakesSpokenSend = false;
      // Set ahead of the capture teardown, so a throw there must not strand it.
      this.isStoppingSession = false;
    }
  }

  /**
   * Reruns the heard-as rules over each of the session's passages as it was
   * transcribed, so a phrase that was split between utterances, or that a
   * shorter phrase took first, comes out as one term, and a term already
   * written is never rewritten again. Rules changed since the session began
   * apply to all of it alike. Synchronous, so it lands before stop() resolves
   * and before any send or correction can read the draft. Returns each
   * passage it rewrote, in draft order.
   */
  private applyHeardAsRules(
    target: VoiceRecordingTarget,
    sessionId: string | null,
    rewrite: HeardAsRewriter,
    include?: (utterance: DictationUtterance) => boolean,
    keepUtterances = false
  ): PassageRewrite[] {
    const record = findDictation(target, sessionId);
    if (!record) return [];
    const { panelId, projectId } = target;
    const inputStore = useTerminalInputStore.getState();
    const draft = inputStore.getDraftInput(panelId, projectId);
    const draftKey = makeDraftKey(panelId, projectId);
    const rewrites: PassageRewrite[] = [];
    for (const passage of collectCorrectionPassages(record, draft, include)) {
      const transcribed = transcribedPassage(record, passage, draft);
      const heard = transcribed.text;
      // The draft either side is context, so a phrase that runs on into text
      // typed against the passage is still judged as one word.
      const before = draft.slice(0, passage.from);
      const after = draft.slice(passage.to);
      const edits: VoiceTextEdit[] = [];
      const rewritten = rewrite(
        before + heard + after,
        { from: before.length, to: before.length + heard.length },
        edits
      );
      const text = rewritten.slice(before.length, rewritten.length - after.length);
      if (text === passage.text) continue;
      // The unsure words follow the rules' own replacements, from the words as
      // heard; one a rule replaced is dropped.
      const uncertain = sliceSpans(
        carrySpansThroughEdits(shiftSpans(transcribed.uncertain, before.length), edits),
        before.length,
        before.length + text.length
      );
      // A pause stays after the word it followed, and after a term a rule
      // wrote over words it fell between.
      const pauses = normalizePausePositions(
        text,
        slicePausePositions(
          carryPausePositionsThroughEdits(
            shiftPausePositions(transcribed.pauses, before.length),
            edits
          ),
          before.length,
          before.length + text.length
        )
      );
      const current = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
      const pending = peekPendingComposerSelection(draftKey, current);
      const caret = pending ?? readComposerSelection(draftKey, current);
      // A chunk cut while the dictation runs keeps its utterances apart, so a
      // scratch still takes just the last of them.
      const span = keepUtterances
        ? (useDictationRangeStore
            .getState()
            .rewriteUtterances(
              record.id,
              [{ passage, text, heard: { uncertain, pauses } }],
              (next) => useTerminalInputStore.getState().setDraftInput(panelId, next, projectId)
            )?.[0] ?? null)
        : useDictationRangeStore
            .getState()
            .rewritePassage(
              record.id,
              passage,
              text,
              heard,
              { text: uncertain, heard: transcribed.uncertain },
              { text: pauses, heard: transcribed.pauses }
            );
      if (!span) continue;
      const delta = text.length - (span.to - span.from);
      // A caret that followed the words, or sits in them, stays with them, and
      // one an earlier voice write left waiting still lands. Any other caret
      // the composer carries through the write itself.
      if (caret && (pending || (caret.from >= span.from && caret.to <= span.to))) {
        const place = (at: number) =>
          at <= span.from ? at : at >= span.to ? at + delta : span.from + text.length;
        setPendingComposerSelection(
          draftKey,
          useTerminalInputStore.getState().getDraftInput(panelId, projectId),
          { from: place(caret.from), to: place(caret.to) }
        );
      }
      // A session restarted on this panel dictates after the passage.
      useVoiceRecordingStore.getState().shiftDraftOffsets(panelId, span.to, delta);
      rewrites.push({ landed: passage.text, rewritten: text });
    }
    // Like the words it rewrites, it leaves the caret to the user.
    if (rewrites.length > 0) inputStore.bumpExternalDraftRevision({ keepsSelection: true });
    return rewrites;
  }

  /**
   * The end of a dictation's cleanup, at a graceful stop: the learning
   * baseline and the recent-dictations entry over all of it, then the
   * stop-time pass over whatever no chunk took (#14772). That pass marks each
   * passage with the `cm-voice-pending-ai` decoration, sends each with the
   * draft text before it as context, and swaps each cleaned result into its
   * own range only if that range still holds what was sent. Text typed or
   * pasted around or between the passages is never sent or rewritten.
   * Best-effort — any failure leaves the raw text. Registered synchronously,
   * before the requests go out.
   */
  private finishDictationCleanup(
    target: VoiceRecordingTarget,
    sessionId: string | null,
    transcript: FinishedTranscript | null,
    timeline: VoiceSessionTimeline | null,
    correctionEnabled: boolean
  ): void {
    const { panelId, projectId } = target;
    const record = findDictation(target, sessionId);
    if (!record) {
      // The draft was sent or cleared mid-dictation: chunks that already have
      // their replies leave nothing else to let the cleanup go.
      const orphan = sessionId ? this.cleanups.get(sessionId) : undefined;
      if (orphan) this.keepCleanedHistory(orphan);
      return;
    }
    const cleanup =
      this.cleanups.get(record.sessionId) ?? this.openCleanup(target, record.sessionId);
    cleanup.stopped = true;
    cleanup.retriesAfterStop = correctionEnabled;
    const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
    // Every word the draft still holds as dictated, chunks already cleaned included.
    const dictated = collectCorrectionPassages(record, draft);
    const tail = correctionEnabled
      ? collectCorrectionPassages(record, draft, (u) => !cleanup.claimed.has(u.id))
      : [];
    const seed = joinPassageTexts(dictated.map((p) => p.text));

    if (seed !== null || !correctionEnabled) {
      // Seeded before any reply, so the panel keeps a usable baseline even if
      // no cleanup ever lands (#9749). Each passage still on its way has its
      // place in it, for its cleaned text to take.
      const spans = new Map<CorrectionPassage, { from: number; to: number }>();
      const starts: number[] = [];
      dictated.reduce((at, run) => (starts.push(at), at + run.text.length + 1), 0);
      const place = (passage: CorrectionPassage, at: { from: number; to: number }) => {
        const i = dictated.findIndex((run) => run.from <= at.from && at.to <= run.to);
        if (i < 0) return;
        const start = starts[i]! - dictated[i]!.from;
        spans.set(passage, { from: start + at.from, to: start + at.to });
      };
      for (const pass of cleanup.passes) {
        if (pass.done) continue;
        for (const [passage, at] of this.locateLivePassages(pass)) place(passage, at);
      }
      for (const passage of tail) place(passage, passage);
      cleanup.baseline = seed === null ? null : { text: seed, spans };
      this.baselineOwners.set(panelId, cleanup);
      useVoiceRecordingStore.getState().setSessionCorrectedText(panelId, seed);
      if (seed) this.followLearningBaselines();
    }

    // Cleanup over part of the session (an edit or a send got there first)
    // would stand in for all of it, so only passes over every word count.
    if (transcript) {
      const order = new Map(record.utterances.map((u, i) => [u.id, i]));
      const at = (passage: CorrectionPassage) =>
        Math.min(...passage.utteranceIds.map((id) => order.get(id) ?? Infinity));
      const passages = [
        ...cleanup.passes
          .flatMap((pass) => pass.passages)
          .filter((passage) => !cleanup.released.has(passage)),
        ...tail,
      ].sort((a, b) => at(a) - at(b));
      if (
        passages.length > 0 &&
        sameDictatedWords(passages.map((p) => p.text).join(" "), transcript.rawText)
      ) {
        cleanup.history = { id: transcript.id, passages };
      }
    }

    if (tail.length > 0) {
      logDebug(`${LOG_PREFIX} Running correction`, {
        panelId,
        passages: tail.length,
        chunks: cleanup.passes.length,
        rawLength: tail.reduce((sum, p) => sum + p.text.length, 0),
      });
      this.registerCorrection(
        "stop",
        cleanup,
        target,
        voiceContext(target),
        record.id,
        tail,
        timeline
      );
    }
    this.keepCleanedHistory(cleanup);
  }

  private openCleanup(target: VoiceRecordingTarget, sessionId: string): DictationCleanup {
    const cleanup: DictationCleanup = {
      sessionId,
      panelId: target.panelId,
      projectId: target.projectId,
      claimed: new Set(),
      passes: [],
      results: new Map(),
      released: new Set(),
      failed: new Set(),
      rewrites: [],
      stopped: false,
      retriesAfterStop: false,
      history: null,
      baseline: null,
    };
    this.cleanups.set(sessionId, cleanup);
    return cleanup;
  }

  /** Registers a pass over `passages` and sends it. */
  private registerCorrection(
    kind: PendingCorrection["kind"],
    cleanup: DictationCleanup,
    target: { panelId: string; projectId?: string },
    context: VoiceContext,
    dictationId: string,
    passages: CorrectionPassage[],
    timeline: VoiceSessionTimeline | null
  ): void {
    const { panelId, projectId } = target;
    let settle!: () => void;
    const correction: PendingCorrection = {
      kind,
      cleanup,
      panelId,
      projectId,
      context,
      dictationId,
      sessionId: cleanup.sessionId,
      passages,
      live: new Set(passages),
      rewrites: new Map(),
      done: false,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
      timeline,
      replied: false,
      counted: false,
      startedAt: performance.now(),
      // The passages go out together, so the pass lands with its slowest.
      expectedMs: Math.max(
        0,
        ...passages.map((passage) =>
          estimateCorrectionMs(
            this.cleanupModel,
            cleanupReasoningEffortFor(this.cleanupModel, {
              chars: passage.text.trim().length,
              continuing: passage.context.length > 0,
            }),
            passage.text.length
          )
        )
      ),
    };
    cleanup.passes.push(correction);
    if (kind === "stop") timeline?.beginCorrection();
    else timeline?.beginChunkPass();
    this.pendingCorrections.add(correction);
    for (const observer of this.sendObservers) {
      if (this.correctionFor(correction, observer.panelId, observer.sessions)) {
        observer.passes.add(correction);
      }
    }
    this.watchCorrectionDrafts();

    // Show the dotted-underline "correcting" decoration over each passage.
    this.syncCorrectionRange(panelId);
    useTerminalInputStore.getState().bumpExternalDraftRevision({ keepsSelection: true });

    void this.requestCorrection(correction);
  }

  /** Prefetches the stop's cleanup once the words that just landed have settled. */
  private schedulePrefetch(sessionId: string): void {
    this.cancelScheduledPrefetch();
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.prefetchCleanup(sessionId);
    }, VoiceRecordingService.PREFETCH_SETTLE_MS);
  }

  private cancelScheduledPrefetch(): void {
    if (this.prefetchTimer === null) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
  }

  /**
   * Sends main the cleanup requests a stop right now would send, built as the
   * stop builds them, so a stop that follows this pause with nothing more said
   * takes replies already on their way instead of waiting out a new round
   * trip. Anything that changes a request in between, more words, an edit, a
   * prompt sent, leaves the stop to send its own.
   */
  private prefetchCleanup(sessionId: string): void {
    const target = this.chunkingTarget(sessionId);
    const record = target ? findDictation(target, sessionId) : null;
    if (!target || !record) return;
    const draft = useTerminalInputStore.getState().getDraftInput(target.panelId, target.projectId);
    const cleanup = this.cleanups.get(record.sessionId);
    const passages = collectCorrectionPassages(record, draft, (u) => !cleanup?.claimed.has(u.id));
    const now = performance.now();
    // A spoken file reference still resolving will rewrite its words: try
    // again when its links land, or once they can no longer.
    const linksDueAt = Math.max(
      0,
      ...record.utterances.map((u) =>
        u.transcriptId === undefined ? 0 : (this.fileLinksDue.get(u.transcriptId) ?? 0)
      )
    );
    if (linksDueAt > now) {
      this.cancelScheduledPrefetch();
      this.prefetchTimer = setTimeout(() => {
        this.prefetchTimer = null;
        this.prefetchCleanup(sessionId);
      }, linksDueAt - now);
      return;
    }
    if (passages.length === 0) return;
    const context = voiceContext(target);
    void window.electron.voiceInput
      .prefetchCorrections({
        sessionId: record.sessionId,
        requests: passages.map((passage) => correctionRequest(passage, context, record.sessionId)),
      })
      .catch((error: unknown) => {
        logDebug(`${LOG_PREFIX} Cleanup prefetch failed`, voiceErrorLogFields(error));
      });
  }

  /**
   * The live session's next words begin: after a long enough quiet since its
   * last ones landed, the end of those is a pause a chunk may be cut at.
   */
  private noteNextWords(sessionId: string): void {
    if (this.lastWordsAt === null) return;
    if (performance.now() - this.lastWordsAt < VoiceRecordingService.CHUNK_PAUSE_MS) return;
    this.proposeChunkBreak(sessionId, false);
  }

  /**
   * Marks the end of the live session's latest words as a place to cut a
   * chunk for cleanup, to be judged on what is said next.
   */
  private proposeChunkBreak(sessionId: string, paragraph: boolean): void {
    // A break still waiting is judged on whatever was said after it.
    this.settleChunkBreak(true);
    const target = this.chunkingTarget(sessionId);
    if (!target) return;
    const last = findDictation(target, sessionId)?.utterances.at(-1);
    if (!last || this.cleanups.get(sessionId)?.claimed.has(last.id)) return;
    this.chunkBreak = { sessionId, utteranceId: last.id, paragraph, after: "" };
  }

  /** Words said after the waiting break, from the session they belong to. */
  private followChunkBreak(sessionId: string, text: string): void {
    const pending = this.chunkBreak;
    if (!pending || pending.sessionId !== sessionId) return;
    pending.after = pending.after ? `${pending.after} ${text}` : text;
    this.settleChunkBreak(false);
  }

  /**
   * Judges the waiting break once enough was said after it to tell, or at
   * once when `force`d by a newer one: cuts a chunk there, or lets the
   * dictation run on past it. A chunk still waiting on file links keeps its
   * break for the next try, unless a newer break replaces it.
   */
  private settleChunkBreak(force: boolean): void {
    const pending = this.chunkBreak;
    if (!pending) return;
    // Too little said to judge it ("I", then a pause, then "mean…"): a newer
    // break replaces it uncut.
    const decides = chunkFollowUpDecides(pending.after);
    if (!decides && !force) return;
    if ((decides ? this.cutChunk(pending) : "no") !== "wait" || force) {
      if (this.chunkBreak === pending) this.chunkBreak = null;
    }
  }

  /** The live dictation's target, while its words may still be cut into chunks. */
  private chunkingTarget(sessionId: string): VoiceRecordingTarget | null {
    const state = useVoiceRecordingStore.getState();
    const target = state.activeTarget;
    if (!target || target.rewrite || !state.correctionEnabled) return null;
    if (state.status === "finishing" || this.stopPromise || this.isStoppingSession) return null;
    return state.panelBuffers[target.panelId]?.dictationSessionId === sessionId ? target : null;
  }

  /**
   * Sends the dictation up to `at` for cleanup while it goes on: every word
   * no earlier chunk took, once there are enough of them and what was said
   * after the break shows the speaker isn't reaching back over it.
   */
  private cutChunk(at: ChunkBreak): "cut" | "no" | "wait" {
    const target = this.chunkingTarget(at.sessionId);
    const record = target ? findDictation(target, at.sessionId) : null;
    const end = record ? record.utterances.findIndex((u) => u.id === at.utteranceId) : -1;
    if (!target || !record || end < 0) return "no";
    const { panelId, projectId } = target;
    const draft = () => useTerminalInputStore.getState().getDraftInput(panelId, projectId);
    const cleanup = this.cleanups.get(at.sessionId);
    const upTo = new Set(record.utterances.slice(0, end + 1).map((u) => u.id));
    const include = (u: DictationUtterance) => upTo.has(u.id) && !cleanup?.claimed.has(u.id);
    const passages = collectCorrectionPassages(record, draft(), include);
    const last = passages[passages.length - 1];
    if (
      !last ||
      last.utteranceIds[last.utteranceIds.length - 1] !== at.utteranceId ||
      passages.reduce((sum, p) => sum + p.text.length, 0) < VoiceRecordingService.CHUNK_MIN_CHARS ||
      !mayCutChunk(last.text, at.after, at.paragraph)
    ) {
      return "no";
    }
    const now = performance.now();
    const linksDue = passages.some((passage) =>
      passage.utteranceIds.some((id) => {
        const transcriptId = record.utterances.find((u) => u.id === id)?.transcriptId;
        return transcriptId !== undefined && (this.fileLinksDue.get(transcriptId) ?? 0) > now;
      })
    );
    if (linksDue) return "wait";

    const owner = cleanup ?? this.openCleanup(target, at.sessionId);
    // As at stop, a phrase split between two of its utterances is caught first.
    if (this.heardAsRules) {
      owner.rewrites.push(
        ...this.applyHeardAsRules(target, at.sessionId, this.heardAsRules, include, true)
      );
    }
    const current = findDictation(target, at.sessionId);
    const chunk = current ? collectCorrectionPassages(current, draft(), include) : [];
    if (!current || chunk.length === 0) return "no";
    for (const passage of chunk) {
      for (const id of passage.utteranceIds) owner.claimed.add(id);
    }
    const timeline = this.timelines.get(at.sessionId) ?? null;
    timeline?.noteCorrectionChunk();
    logDebug(`${LOG_PREFIX} Cleaning up a chunk`, {
      panelId,
      passages: chunk.length,
      rawLength: chunk.reduce((sum, p) => sum + p.text.length, 0),
    });
    this.registerCorrection(
      "chunk",
      owner,
      target,
      voiceContext(target),
      current.id,
      chunk,
      timeline
    );
    return "cut";
  }

  /**
   * A chunk passage that couldn't land while its dictation runs gives its
   * words back, for the next chunk or the stop-time pass to clean.
   */
  private releaseChunkPassage(correction: PendingCorrection, passage: CorrectionPassage): void {
    const { cleanup } = correction;
    if (correction.kind !== "chunk" || cleanup.stopped || cleanup.released.has(passage)) return;
    cleanup.released.add(passage);
    for (const id of passage.utteranceIds) cleanup.claimed.delete(id);
  }

  /**
   * Cleans again, in a pass of its own, the chunk passages that couldn't land
   * once the stop-time pass had gone out without their words (#14932). Called
   * before the chunk's pass is through, so a send waiting on it waits on this
   * too, and the history and baseline wait for its text in their place.
   */
  private cleanChunkAgain(correction: PendingCorrection, passages: CorrectionPassage[]): void {
    const { cleanup } = correction;
    const record = useDictationRangeStore.getState().getDictation(correction.dictationId);
    if (!record) return;
    const draft = useTerminalInputStore
      .getState()
      .getDraftInput(correction.panelId, correction.projectId);
    const again: CorrectionPassage[] = [];
    for (const passage of passages) {
      if (cleanup.released.has(passage)) continue;
      cleanup.released.add(passage);
      const ids = new Set(passage.utteranceIds);
      const fresh = collectCorrectionPassages(record, draft, (u) => ids.has(u.id));
      again.push(...fresh);
      const same = fresh.length === 1 && fresh[0]!.text === passage.text ? fresh[0]! : null;
      const history = cleanup.history?.passages;
      const at = history?.indexOf(passage) ?? -1;
      if (history && at >= 0) {
        // The history keeps cleaned text only from passes over every word.
        if (same) history.splice(at, 1, same);
        else cleanup.history = null;
      }
      const span = cleanup.baseline?.spans.get(passage);
      if (cleanup.baseline && span) {
        cleanup.baseline.spans.delete(passage);
        if (same) cleanup.baseline.spans.set(same, span);
      }
    }
    if (again.length === 0) return;
    logDebug(`${LOG_PREFIX} Cleaning up a chunk again after the stop`, {
      panelId: correction.panelId,
      passages: again.length,
      rawLength: again.reduce((sum, p) => sum + p.text.length, 0),
    });
    this.registerCorrection(
      "retry",
      cleanup,
      correction,
      correction.context,
      correction.dictationId,
      again,
      correction.timeline
    );
  }

  /** Counts a chunk or retry's passages into the session's summary, once. */
  private countChunkPass(correction: PendingCorrection, fates: PassageFate[]): void {
    if (correction.kind === "stop" || correction.counted) return;
    correction.counted = true;
    correction.timeline?.endChunkPass(countPassageFates(fates));
  }

  /**
   * Gives the recent-dictations entry the cleaned text once the dictation has
   * stopped and every pass over it has its reply, and lets the cleanup go.
   */
  private keepCleanedHistory(cleanup: DictationCleanup): void {
    if (!cleanup.stopped) return;
    if (cleanup.passes.some((pass) => pass.passages.some((p) => !cleanup.results.has(p)))) return;
    if (this.cleanups.get(cleanup.sessionId) === cleanup) this.cleanups.delete(cleanup.sessionId);
    const history = cleanup.history;
    cleanup.history = null;
    if (!history || history.passages.some((passage) => cleanup.failed.has(passage))) return;
    const texts = history.passages.map((passage) => cleanup.results.get(passage) ?? null);
    if (texts.every((text) => text === null)) return;
    keepRecentDictationCorrection(
      history.id,
      history.passages.map((passage, i) => texts[i] ?? passage.text).join(" ")
    );
  }

  /**
   * A chunk that landed while its dictation ran, for an undo or redo to move
   * within the baseline its stop writes later: just its passages, either side.
   */
  private chunkBaseline(
    correction: PendingCorrection,
    edits: ReadonlyArray<{ passage: CorrectionPassage; text: string }>
  ): CorrectionBaseline | null {
    if (correction.kind !== "chunk" || correction.cleanup.stopped || edits.length === 0) {
      return null;
    }
    // From its first rewritten passage to its last, the ones left as they
    // were included, so it reads as one stretch of the baseline.
    const rewritten = new Map(edits.map(({ passage, text }) => [passage, text]));
    const { passages } = correction;
    const at = passages.flatMap((passage, i) => (rewritten.has(passage) ? [i] : []));
    const stretch = passages.slice(at[0], at[at.length - 1]! + 1);
    const raw = joinPassageTexts(stretch.map((passage) => passage.text));
    const corrected = joinPassageTexts(
      stretch.map((passage) => rewritten.get(passage) ?? passage.text)
    );
    return raw && corrected ? { raw, corrected, partOf: correction.cleanup.sessionId } : null;
  }

  /**
   * Puts a pass's settled passages into the learning baseline written at
   * stop, while it is still the one the panel holds. Returns the baseline on
   * either side, or null when it didn't move. A chunk that landed before the
   * stop needs none: the stop read its words from the draft.
   */
  private foldIntoBaseline(
    cleanup: DictationCleanup,
    settled: ReadonlyMap<CorrectionPassage, string>
  ): CorrectionBaseline | null {
    const baseline = cleanup.baseline;
    const store = useVoiceRecordingStore.getState();
    const buffer = store.panelBuffers[cleanup.panelId];
    const current = buffer?.sessionCorrectedText;
    if (!baseline || !current || this.baselineOwners.get(cleanup.panelId) !== cleanup) return null;
    if (current !== baseline.text) {
      // An undo or redo moved a chunk inside it meanwhile, so the places
      // taken at stop no longer hold: each passage is found by its words.
      if (buffer.dictationSessionId !== cleanup.sessionId) return null;
      baseline.text = current;
      baseline.spans.clear();
    }
    const pieces = [...settled]
      .flatMap(([passage, text]) => {
        const span = baseline.spans.get(passage);
        baseline.spans.delete(passage);
        if (span) return [{ ...span, text }];
        const at = current.indexOf(passage.text);
        if (!passage.text || at < 0 || current.indexOf(passage.text, at + 1) >= 0) return [];
        return [{ from: at, to: at + passage.text.length, text }];
      })
      .sort((a, b) => b.from - a.from);
    const raw = baseline.text;
    let text = raw;
    for (const piece of pieces) {
      text = text.slice(0, piece.from) + piece.text + text.slice(piece.to);
      const delta = piece.text.length - (piece.to - piece.from);
      for (const span of baseline.spans.values()) {
        if (span.from >= piece.to) {
          span.from += delta;
          span.to += delta;
        }
      }
    }
    if (text === raw) return null;
    baseline.text = text;
    store.setSessionCorrectedText(cleanup.panelId, text);
    return { raw, corrected: text };
  }

  private async requestCorrection(correction: PendingCorrection): Promise<void> {
    const { cleanup } = correction;
    const { results, last } = await settlePassageReplies(
      correction.passages.map((passage) => this.requestPassageCorrection(passage, correction))
    );
    correction.replied = true;
    if (correction.kind === "stop") {
      correction.timeline?.noteCorrectionReplies(last?.timing ?? null, last?.prefetch ?? null);
    }
    correction.passages.forEach((passage, i) => {
      cleanup.results.set(passage, results[i]?.text ?? null);
      if (results[i]?.failed) cleanup.failed.add(passage);
    });

    const { panelId, projectId } = correction;
    // Placed in the text the composer shows, not the store's copy a render
    // behind it (#15873). Typing that reached a passage drops it as any edit
    // does, and one that reached them all retires the correction here.
    if (!correction.done) writeComposerDraftThrough(panelId, projectId);
    if (correction.done) {
      // The history keeps the cleaned text even when the draft it was meant
      // for was sent or edited first: that is when it's worth recovering.
      this.keepCleanedHistory(cleanup);
      logDebug(`${LOG_PREFIX} Correction result stale (draft sent or edited), discarding`);
      this.releaseBaseline(cleanup);
      const dropped = correction.passages.map((): PassageFate => "dropped");
      if (correction.kind === "stop") {
        correction.timeline?.endCorrection("discarded", countPassageFates(dropped));
      } else {
        this.countChunkPass(correction, dropped);
      }
      return;
    }
    // Every passage is checked against the same draft and written in one
    // change: a write per passage could shift a later passage onto
    // neighbouring identical text and flag it edited.
    const spans = this.locateLivePassages(correction);
    this.retireCorrection(correction);

    const inputStore = useTerminalInputStore.getState();
    const voiceStore = useVoiceRecordingStore.getState();
    const edits: Array<{ from: number; to: number; text: string; passage: CorrectionPassage }> = [];
    let skipped = 0;
    const fates: PassageFate[] = [];
    correction.passages.forEach((passage, index) => {
      const corrected = results[index]?.text;
      if (!corrected || corrected === passage.text) {
        const reply = results[index];
        const verdict = reply?.verdict ?? (reply?.failed ? "failed" : "unchanged");
        fates.push(verdict === "replaced" ? "unchanged" : verdict);
        return;
      }
      const span = spans.get(passage);
      if (!span) {
        skipped++;
        fates.push("unlanded");
        return;
      }
      fates.push("applied");
      edits.push({ ...span, text: corrected, passage });
    });

    let swapped: Omit<LandedCorrection, "baseline" | "sessionId"> | null = null;
    if (edits.length > 0) {
      const before = inputStore.getDraftInput(panelId, projectId);
      const changes = draftChanges(before, edits);
      let next = before;
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i]!;
        next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
      }
      // A session dictating on this panel, this pass's own included, writes
      // after the passages; its offsets move with their new lengths.
      const shiftOffsets = () => {
        for (let i = edits.length - 1; i >= 0; i--) {
          const edit = edits[i]!;
          voiceStore.shiftDraftOffsets(panelId, edit.to, edit.text.length - (edit.to - edit.from));
        }
      };
      let written = true;
      if (correction.kind === "chunk") {
        // Still the session's words, each utterance its own, so a scratch, a
        // cancel and the passes after this one see them as dictated.
        written =
          useDictationRangeStore.getState().rewriteUtterances(
            correction.dictationId,
            edits.map(({ passage, text }) => ({ passage, text })),
            (draft) => this.writeShiftedDraft(panelId, draft, projectId)
          ) !== null;
        if (written) shiftOffsets();
      } else {
        shiftOffsets();
        // Spelled out, so the text between passages, and a session dictating
        // there, isn't taken as rewritten along with them.
        useDictationRangeStore
          .getState()
          .expectDraftChange(panelId, projectId, before, next, changes);
        this.writeShiftedDraft(panelId, next, projectId);
      }
      if (written) {
        // One span from the first rewritten passage to the last, so restoring
        // it puts every passage back and leaves text typed between them as it is.
        const from = Math.min(...edits.map((edit) => edit.from));
        const to = Math.max(...edits.map((edit) => edit.to));
        swapped = {
          from,
          rawText: before.slice(from, to),
          correctedText: next.slice(from, to + next.length - before.length),
          write: { before, after: next, changes },
        };
      } else {
        skipped += edits.length;
        for (const { passage } of edits) fates[correction.passages.indexOf(passage)] = "unlanded";
        edits.length = 0;
      }
    }
    logDebug(`${LOG_PREFIX} Correction settled`, { panelId, applied: edits.length, skipped });

    // A chunk passage still in place that the model couldn't clean, or the
    // draft couldn't take, gives its words to a later
    // pass. One an edit reached keeps only the words it left, already given.
    if (correction.kind === "chunk") {
      const again = correction.passages.filter(
        (passage, i) => spans.has(passage) && CLEANED_AGAIN.has(fates[i]!)
      );
      if (!cleanup.stopped) {
        for (const passage of again) this.releaseChunkPassage(correction, passage);
      } else if (cleanup.retriesAfterStop && again.length > 0) {
        this.cleanChunkAgain(correction, again);
      }
    }
    // After any pass over what this one couldn't land, which it then waits for.
    this.keepCleanedHistory(cleanup);

    // The settled dictated text goes into the learning baseline. Manual edits
    // the user makes before sending are diffed against it to detect words
    // worth suggesting for the custom dictionary (#9749). A result that wasn't
    // applied never reached the draft, so it stays out.
    const baseline =
      this.foldIntoBaseline(cleanup, new Map(edits.map(({ passage, text }) => [passage, text]))) ??
      this.chunkBaseline(correction, edits);
    this.releaseBaseline(cleanup);
    if (swapped) {
      recordCorrectionLanded(panelId, projectId, {
        ...swapped,
        baseline,
        sessionId: cleanup.sessionId,
      });
    }

    this.syncCorrectionRange(panelId);
    inputStore.bumpExternalDraftRevision({ keepsSelection: true });
    // A passage that couldn't land outranks one that did: the summary is
    // there to show what went wrong.
    let outcome: VoiceCorrectionOutcome = "unchanged";
    if (skipped > 0) outcome = "discarded";
    else if (edits.length > 0) outcome = "applied";
    else if (results.some((result) => result.failed)) outcome = "failed";
    if (correction.kind === "stop") {
      correction.timeline?.endCorrection(outcome, countPassageFates(fates));
    } else {
      this.countChunkPass(correction, fates);
    }
  }

  /**
   * The cleaned text for one passage, or null to keep it as dictated, and
   * whether the request failed rather than coming back unchanged.
   */
  private async requestPassageCorrection(
    passage: CorrectionPassage,
    correction: PendingCorrection
  ): Promise<{
    text: string | null;
    failed: boolean;
    verdict: VoiceCorrectionVerdict | undefined;
    timing: unknown;
    prefetch: unknown;
  }> {
    // Unique past an HMR swap, which leaves the old singleton's requests out.
    const streamId = crypto.randomUUID();
    this.correctionStreams.set(streamId, {
      correction,
      passage,
      aligner: new CorrectionStreamAligner(passage.text),
    });
    let text: string | null = null;
    try {
      const result = await window.electron.voiceInput.correct({
        ...correctionRequest(passage, correction.context, correction.sessionId),
        streamId,
      });
      // Told whatever became of the draft: the account fails the next passage too.
      if (result.cleanupFailure) this.reportCleanupFailure(result.cleanupFailure);
      // Timed whether or not its draft is still there to take it: the call cost
      // the same either way.
      if (!result.failed && result.pace) recordCorrectionPace(passage.text.length, result.pace);
      // The passage runs from its first word to its last; its separators and
      // paragraph breaks either side stay the session's, not the model's.
      text = result.action === "replace" ? result.correctedText.trim() || null : null;
      return {
        text,
        failed: result.failed === true,
        verdict: result.verdict,
        timing: result.timing ?? null,
        prefetch: result.prefetch ?? null,
      };
    } catch (error) {
      logWarn(
        `${LOG_PREFIX} Correction request failed, keeping raw text`,
        voiceErrorLogFields(error)
      );
      return { text: null, failed: true, verdict: "failed", timing: null, prefetch: null };
    } finally {
      this.correctionStreams.delete(streamId);
      // A passage whose cleanup came back shows all of it until every passage
      // lands together; one that was rejected or failed goes back to what was
      // dictated.
      this.showStreamedRewrite(
        correction,
        passage,
        text === null ? null : { rawTo: passage.text.length, text }
      );
    }
  }

  /** Moves a passage's rewrite on as its cleanup streams back. */
  private noteCorrectionProgress(streamId: string, text: string): void {
    const stream = this.correctionStreams.get(streamId);
    if (!stream || stream.correction.done || !stream.correction.live.has(stream.passage)) return;
    const rewrite = stream.aligner.advance(text);
    if (rewrite) this.showStreamedRewrite(stream.correction, stream.passage, rewrite);
  }

  private showStreamedRewrite(
    correction: PendingCorrection,
    passage: CorrectionPassage,
    rewrite: StreamedRewrite | null
  ): void {
    // A dropped passage stays as dictated, whatever its cleanup goes on to say.
    if (correction.done || !correction.live.has(passage)) return;
    const shown = correction.rewrites.get(passage);
    if (shown?.rawTo === rewrite?.rawTo && shown?.text === rewrite?.text) return;
    if (rewrite) correction.rewrites.set(passage, rewrite);
    else correction.rewrites.delete(passage);
    this.syncCorrectionRange(correction.panelId);
  }

  /**
   * Sends a finished instruction and its selection to the correction model.
   * Registered before stop() resolves, so a send waits for it like a
   * correction; an edit that reaches the selection drops it.
   */
  private runRewrite(target: VoiceRecordingTarget, rewrite: VoiceRewriteRequest): void {
    const { selection } = rewrite;
    const instruction = rewrite.instruction
      .join(" ")
      .trim()
      .slice(0, VOICE_REWRITE_MAX_INSTRUCTION_CHARS);
    if (!instruction) {
      selection.release();
      this.reportRewriteSkipped("No instruction was heard. The selection is unchanged.");
      return;
    }
    this.requestRewrite(target.panelId, target.projectId, selection, instruction);
  }

  private requestRewrite(
    panelId: string,
    projectId: string | undefined,
    selection: RewriteSelection,
    instruction: string
  ): void {
    const driven = drivenElsewhereFor(projectId);
    if (driven) {
      selection.release();
      this.reportRewriteSkipped(
        `${controllerName(driven)} has control of this project, so the selection wasn't rewritten.`
      );
      return;
    }
    if (!selection.range()) {
      this.reportRewriteSkipped("The selection was edited, so it wasn't rewritten.");
      return;
    }
    let settle!: () => void;
    const job: PendingRewrite = {
      panelId,
      projectId,
      selection,
      done: false,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    this.pendingRewrites.add(job);
    selection.onLost(() => {
      if (job.done) return;
      logDebug(`${LOG_PREFIX} Rewrite selection edited, discarding`);
      this.retireRewrite(job);
      this.syncCorrectionRange(panelId);
    });
    this.syncCorrectionRange(panelId);
    useVoiceRecordingStore.getState().announce("Rewriting selection…");
    const selectedText = selection.text;
    logDebug(`${LOG_PREFIX} Requesting rewrite`, {
      panelId,
      selectionLength: selectedText.length,
      instructionLength: instruction.length,
    });
    void this.settleRewrite(job, instruction);
  }

  private async settleRewrite(job: PendingRewrite, instruction: string): Promise<void> {
    let outcome: VoiceRewriteOutcome;
    try {
      outcome = await window.electron.voiceInput.rewrite({
        selectedText: job.selection.text,
        instruction,
      });
    } catch (error) {
      logWarn(`${LOG_PREFIX} Rewrite request failed`, voiceErrorLogFields(error));
      outcome = { status: "failed" };
    }
    if (job.done) {
      logDebug(`${LOG_PREFIX} Rewrite result stale (selection edited or draft sent), discarding`);
      return;
    }
    this.retireRewrite(job);
    this.syncCorrectionRange(job.panelId);
    logDebug(`${LOG_PREFIX} Rewrite settled`, { status: outcome.status });

    const { selection } = job;
    switch (outcome.status) {
      case "replace":
        if (selection.apply(outcome.text)) {
          useVoiceRecordingStore
            .getState()
            .announce("Selection rewritten. Undo restores the original.");
        } else {
          this.reportRewriteSkipped("The selection was edited, so it wasn't rewritten.");
        }
        return;
      case "no_change":
        selection.release();
        this.reportRewriteSkipped("The rewrite came back the same as the selection.");
        return;
      case "rejected":
        selection.release();
        this.reportRewriteSkipped(
          "The rewrite changed a reference, path, flag or code span, so the selection was kept."
        );
        return;
      case "unavailable":
        selection.release();
        useVoiceRecordingStore
          .getState()
          .announce(`Rewriting by voice needs an ${this.cleanupKeyIssuer} API key.`);
        this.reportStartFailure(
          "Rewrite unavailable",
          `Add an ${this.cleanupKeyIssuer} API key in voice settings to rewrite selected text by voice.`,
          this.settingsAction()
        );
        return;
      case "failed":
        useVoiceRecordingStore
          .getState()
          .announce("The rewrite failed. The selection is unchanged.");
        notify({
          type: "error",
          title: "Rewrite failed",
          message: "The request failed or timed out. The selection is unchanged.",
          replaceKey: "voice-rewrite",
          context: { eventKind: "connectivity" },
          action: this.retryAction(() =>
            this.requestRewrite(job.panelId, job.projectId, selection, instruction)
          ),
        });
        return;
    }
  }

  /** Main hands a failure that will recur to one reply per outage, so this is said once. */
  private reportCleanupFailure(failure: VoiceCleanupFailure): void {
    const message = cleanupFailureMessage(failure);
    useVoiceRecordingStore.getState().announce(message);
    notify({
      type: "error",
      title: "Dictation cleanup unavailable",
      message,
      replaceKey: "voice-cleanup-failure",
      context: { eventKind: "connectivity" },
      action: this.settingsAction(),
    });
  }

  private reportPassageFailed(): void {
    const message = "Part of what you said didn't transcribe. Dictation is still running.";
    useVoiceRecordingStore.getState().announce(message);
    notify({
      type: "warning",
      title: "Passage not transcribed",
      message,
      priority: "high",
      replaceKey: "voice-passage-failed",
      context: { eventKind: "uiFeedback" },
    });
  }

  private reportReplayAudioLost(message: string): void {
    logWarn(`${LOG_PREFIX} Replay lost held audio`, { code: VOICE_REPLAY_AUDIO_LOST_CODE });
    useVoiceRecordingStore.getState().announce(message);
    notify({
      type: "warning",
      title: "Dictation incomplete",
      message,
      priority: "high",
      replaceKey: "voice-replay-audio-lost",
      context: { eventKind: "connectivity" },
    });
  }

  private reportRewriteSkipped(message: string): void {
    useVoiceRecordingStore.getState().announce(message);
    notify({
      type: "info",
      title: "Selection unchanged",
      message,
      transient: true,
      // Feedback on the user's own gesture: a toast, not just an inbox row.
      priority: "high",
      replaceKey: "voice-rewrite",
      context: { eventKind: "uiFeedback" },
    });
  }

  private retireRewrite(job: PendingRewrite): void {
    if (job.done) return;
    job.done = true;
    this.pendingRewrites.delete(job);
    job.settle();
  }

  /**
   * The dictation sessions a send from this draft takes, read as it starts:
   * every one with words in the draft or cleanup on its way, and the one
   * dictating into it. A session that starts here while the send waits
   * reopens it (#15703); one after it was handed over is the next prompt's.
   */
  sendSessions(panelId: string, projectId: string | undefined): ReadonlySet<string> {
    const sessions = new Set<string>();
    for (const record of useDictationRangeStore.getState().listDictations(panelId, projectId)) {
      sessions.add(record.sessionId);
    }
    for (const correction of this.pendingCorrections) {
      if (correction.panelId === panelId && correction.sessionId) {
        sessions.add(correction.sessionId);
      }
    }
    const { activeTarget, panelBuffers } = useVoiceRecordingStore.getState();
    const active =
      activeTarget?.panelId === panelId ? panelBuffers[panelId]?.dictationSessionId : null;
    if (active) sessions.add(active);
    return sessions;
  }

  /**
   * Whether the correction is one for the panel that a send taking `sessions`
   * owns; without `sessions`, every one on the panel. A spoken rewrite can't
   * start while a send waits (the composer has no selection), so every
   * rewrite on the panel belongs to it.
   */
  private correctionFor(
    correction: PendingCorrection,
    panelId: string,
    sessions: ReadonlySet<string> | undefined
  ): boolean {
    if (correction.panelId !== panelId) return false;
    return !sessions || correction.sessionId === null || sessions.has(correction.sessionId);
  }

  hasPendingCorrection(panelId: string, sessions?: ReadonlySet<string>): boolean {
    for (const correction of this.pendingCorrections) {
      if (this.correctionFor(correction, panelId, sessions)) return true;
    }
    for (const rewrite of this.pendingRewrites) {
      if (rewrite.panelId === panelId) return true;
    }
    return false;
  }

  /**
   * Follows the cleanup a send taking `sessions` owns until `release`: every
   * pass pending as it starts, and any registered after, the stop's and a
   * retry's included. `failed` says whether a passage among them kept its
   * dictated words because its request failed or timed out, with no later
   * pass taking them over (#14959).
   */
  observeSendCorrections(
    panelId: string,
    sessions: ReadonlySet<string>
  ): { failed: () => boolean; release: () => void } {
    const observer = { panelId, sessions, passes: new Set<PendingCorrection>() };
    for (const correction of this.pendingCorrections) {
      if (this.correctionFor(correction, panelId, sessions)) observer.passes.add(correction);
    }
    this.sendObservers.add(observer);
    return {
      failed: () => {
        for (const pass of observer.passes) {
          const { failed, released } = pass.cleanup;
          const kept = (passage: CorrectionPassage) =>
            pass.live.has(passage) && failed.has(passage) && !released.has(passage);
          if (pass.passages.some(kept)) return true;
        }
        return false;
      },
      release: () => {
        this.sendObservers.delete(observer);
        observer.passes.clear();
      },
    };
  }

  /**
   * When the corrections pending for the panel went out, the first of them,
   * and when the last should land, going by how long past ones took, on the
   * `performance.now()` clock; null with none pending, or when one has no
   * estimate (a spoken rewrite). Given `sessions`, only theirs count.
   */
  expectedCorrectionWindow(
    panelId: string,
    sessions?: ReadonlySet<string>
  ): { startedAt: number; landsAt: number } | null {
    let span: { startedAt: number; landsAt: number } | null = null;
    for (const correction of this.pendingCorrections) {
      if (!this.correctionFor(correction, panelId, sessions)) continue;
      const landsAt = correction.startedAt + correction.expectedMs;
      span = span
        ? {
            startedAt: Math.min(span.startedAt, correction.startedAt),
            landsAt: Math.max(span.landsAt, landsAt),
          }
        : { startedAt: correction.startedAt, landsAt };
    }
    for (const rewrite of this.pendingRewrites) {
      if (rewrite.panelId === panelId) return null;
    }
    return span;
  }

  /**
   * Resolves true once every correction pending for the panel has landed or
   * been dropped, or false as soon as `signal` aborts. There is no deadline of
   * its own: each request carries its timeout in main and settles, failed, at
   * the end of it (#14780). Given `sessions`, only theirs count.
   */
  async waitForPendingCorrections(
    panelId: string,
    signal?: AbortSignal,
    sessions?: ReadonlySet<string>
  ): Promise<boolean> {
    if (!this.hasPendingCorrection(panelId, sessions)) return true;
    if (signal?.aborted) return false;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // A dictation restarted and stopped on the panel can register another
      // correction while this waits; it is waited for too, unless it belongs
      // to a session `sessions` leaves out.
      while (this.hasPendingCorrection(panelId, sessions)) {
        const settled: Promise<void>[] = [];
        for (const correction of this.pendingCorrections) {
          if (this.correctionFor(correction, panelId, sessions)) settled.push(correction.settled);
        }
        for (const rewrite of this.pendingRewrites) {
          if (rewrite.panelId === panelId) settled.push(rewrite.settled);
        }
        const landed = await Promise.race([Promise.all(settled).then(() => true), aborted]);
        if (!landed) return false;
      }
      return true;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Drops every correction still pending for the panel, for a send that is
   * taking the draft as it stands. A result that arrives later never lands.
   * Given `sessions`, a newer session's cleanup is left to land on the words
   * the send holds back.
   */
  discardPendingCorrections(panelId: string, sessions?: ReadonlySet<string>): void {
    let dropped = false;
    for (const correction of [...this.pendingCorrections]) {
      if (!this.correctionFor(correction, panelId, sessions)) continue;
      this.retireCorrection(correction);
      dropped = true;
    }
    for (const rewrite of [...this.pendingRewrites]) {
      if (rewrite.panelId !== panelId) continue;
      this.retireRewrite(rewrite);
      rewrite.selection.release();
      dropped = true;
    }
    if (dropped) this.syncCorrectionRange(panelId);
  }

  /**
   * The send's split of the draft as it reads now: a session it held back can
   * keep writing, or have its cleanup land, while the send is out. Null once
   * the text outside those sessions is no longer what the send took.
   */
  private replanHeldBack(send: VoiceDraftSend): VoiceDraftSend | null {
    const { panelId, projectId } = send;
    const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
    if (draft === send.draft) return send;
    const records = useDictationRangeStore.getState().listDictations(panelId, projectId);
    const now = planVoiceDraftSend({ panelId, projectId }, draft, records, send.sessions);
    return now.text === send.text ? now : null;
  }

  /** Whether the draft still holds what the send took, ahead of whatever was held back. */
  holdsBackFrom(send: VoiceDraftSend): boolean {
    return this.replanHeldBack(send) !== null;
  }

  /**
   * Leaves the draft with what a dictated send held back, once the rest has
   * gone: the words of the sessions started after it, still theirs, so one
   * still dictating carries on after them and a cleanup on its way still
   * lands. Returns the draft it leaves, or null, writing nothing, once the
   * text the send took has changed.
   */
  keepHeldBackDictation(send: VoiceDraftSend): string | null {
    const now = this.replanHeldBack(send);
    if (!now) return null;
    const { panelId, projectId } = now;
    const ranges = useDictationRangeStore.getState();
    if (now.leadingSpace) {
      ranges.yieldLeadingSpace(now.leadingSpace.dictationId, now.leadingSpace.span);
    }
    // A session still dictating counts its offsets from the start of the draft.
    const voiceStore = useVoiceRecordingStore.getState();
    for (const change of [...now.changes].reverse()) {
      voiceStore.shiftDraftOffsets(panelId, change.to, change.from - change.to);
    }
    ranges.expectDraftChange(panelId, projectId, now.draft, now.kept, now.changes);
    this.writeShiftedDraft(panelId, now.kept, projectId);
    return now.kept;
  }

  /** Lets the panel's baseline go once every pass of the dictation that owns it is done. */
  private releaseBaseline(cleanup: DictationCleanup): void {
    if (!cleanup.stopped || cleanup.passes.some((pass) => !pass.done)) return;
    if (this.baselineOwners.get(cleanup.panelId) === cleanup) {
      this.baselineOwners.delete(cleanup.panelId);
    }
  }

  private retireCorrection(correction: PendingCorrection): void {
    if (correction.done) return;
    correction.done = true;
    this.pendingCorrections.delete(correction);
    // Dropped before its replies: the summary needn't wait for them.
    if (!correction.replied) {
      this.countChunkPass(
        correction,
        correction.passages.map(() => "dropped")
      );
    }
    correction.settle();
    if (this.pendingCorrections.size === 0) {
      this.unwatchCorrectionDrafts?.();
      this.unwatchCorrectionDrafts = null;
    }
  }

  /**
   * Removes the session's latest dictated utterance from the draft, with how
   * many of the transcriber's segments it held: more than one when a chunk's
   * cleanup ran several together. Refused when there was none left to remove,
   * or only an edited one.
   */
  private scratchLastUtterance(
    panelId: string,
    projectId: string | undefined,
    sessionId: string | null | undefined
  ): ScratchOutcome {
    if (!sessionId) return { kind: "refused", reason: "nothing" };
    const inputStore = useTerminalInputStore.getState();
    const draft = inputStore.getDraftInput(panelId, projectId);
    const ranges = useDictationRangeStore.getState();
    const last = ranges
      .listDictations(panelId, projectId)
      .find((record) => record.sessionId === sessionId)
      ?.utterances.at(-1);
    const span = ranges.takeLastUtterance({ sessionId, panelId, projectId }, draft);
    if (!span) return { kind: "refused", reason: last?.insertion.edited ? "edited" : "nothing" };
    const next = draft.slice(0, span.from) + draft.slice(span.to);
    // A caret that followed the words stays where they were. The composer's
    // own diff could slide it along a run the removal shares with the text
    // after it, as the ranges below would be without the change spelled out.
    const draftKey = makeDraftKey(panelId, projectId);
    const caret =
      peekPendingComposerSelection(draftKey, draft) ?? readComposerSelection(draftKey, draft);
    if (caret && caret.from >= span.from && caret.to <= span.to) {
      setPendingComposerSelection(draftKey, next, { from: span.from, to: span.from });
    }
    useVoiceRecordingStore.getState().shiftDraftOffsets(panelId, span.to, -(span.to - span.from));
    // The anchor and earlier ranges follow the words actually removed, not a
    // repeat of them the diff might pick.
    useDictationRangeStore
      .getState()
      .expectDraftChange(panelId, projectId, draft, next, { ...span, insert: "" });
    inputStore.setDraftInput(panelId, next, projectId);
    recordScratchLanded(panelId, projectId, next);
    // Like the words it removes, it leaves the caret to the user.
    inputStore.bumpExternalDraftRevision({ keepsSelection: true });
    return { kind: "removed", sources: last?.sources ?? 1 };
  }

  /**
   * Where each passage still able to land sits now. A passage an edit has
   * reached, or whose dictation a send or clear released, is dropped for good,
   * so a result arriving later can never land on whatever the draft holds by
   * then.
   */
  private locateLivePassages(
    correction: PendingCorrection
  ): Map<CorrectionPassage, { from: number; to: number }> {
    const record = useDictationRangeStore.getState().getDictation(correction.dictationId);
    const draft = useTerminalInputStore
      .getState()
      .getDraftInput(correction.panelId, correction.projectId);
    const spans = new Map<CorrectionPassage, { from: number; to: number }>();
    for (const passage of correction.live) {
      const span = locatePassage(record, passage, draft);
      if (span) {
        spans.set(passage, span);
      } else {
        correction.live.delete(passage);
        this.releaseChunkPassage(correction, passage);
      }
    }
    return spans;
  }

  /**
   * Checks every pending passage each time the dictation ranges move, which
   * they do straight after any draft edit. A correction left with no passage
   * that can land is done, so a send waiting on it goes at once.
   */
  private watchCorrectionDrafts(): void {
    if (this.unwatchCorrectionDrafts) return;
    this.unwatchCorrectionDrafts = useDictationRangeStore.subscribe(() => {
      const touched = new Set<string>();
      for (const correction of [...this.pendingCorrections]) {
        this.locateLivePassages(correction);
        touched.add(correction.panelId);
        if (correction.live.size === 0) this.retireCorrection(correction);
      }
      for (const panelId of touched) this.syncCorrectionRange(panelId);
    });
  }

  /**
   * Keeps each panel's learning baseline tied to the draft it was dictated
   * into, while any baseline exists. A draft cleared without a send (Escape, a
   * fleet broadcast) takes its baseline with it, or the next unrelated send
   * would be diffed against it; an edit before the passage moves its start.
   */
  private followLearningBaselines(): void {
    if (this.unfollowBaselines) return;
    this.unfollowBaselines = useTerminalInputStore.subscribe((state, prev) => {
      if (state.draftInputs === prev.draftInputs || this.writingShiftedDraft) return;
      const voiceStore = useVoiceRecordingStore.getState();
      let following = false;
      for (const [panelId, buffer] of Object.entries(voiceStore.panelBuffers)) {
        if (buffer.sessionCorrectedText === null || buffer.sessionDraftStart < 0) continue;
        const key = makeDraftKey(panelId, buffer.projectId);
        const before = prev.draftInputs.get(key) ?? "";
        const after = state.draftInputs.get(key) ?? "";
        const start = after.trim() ? mapLearningStart(before, after, buffer.sessionDraftStart) : -1;
        if (start < 0) {
          voiceStore.setSessionCorrectedText(panelId, null);
          continue;
        }
        following = true;
        if (start !== buffer.sessionDraftStart) {
          voiceStore.shiftDraftOffsets(
            panelId,
            buffer.sessionDraftStart,
            start - buffer.sessionDraftStart
          );
        }
      }
      if (!following) this.unfollowLearningBaselines();
    });
  }

  /**
   * Writes a draft whose offsets the caller has already moved with its edits.
   * The baseline follower sits it out: it would move them a second time, or
   * read a start already moved past the edit as one the edit ran across.
   */
  private writeShiftedDraft(panelId: string, draft: string, projectId: string | undefined): void {
    this.writingShiftedDraft = true;
    try {
      useTerminalInputStore.getState().setDraftInput(panelId, draft, projectId);
    } finally {
      this.writingShiftedDraft = false;
    }
  }

  private unfollowLearningBaselines(): void {
    this.unfollowBaselines?.();
    this.unfollowBaselines = null;
  }

  /**
   * Points the panel's "correcting" decoration at its pending passages, each
   * with what its cleanup has streamed over it so far.
   */
  private syncCorrectionRange(panelId: string): void {
    const ranges: VoiceCorrectionRange[] = [];
    for (const correction of this.pendingCorrections) {
      if (correction.panelId !== panelId) continue;
      for (const [passage, span] of this.locateLivePassages(correction)) {
        const rewrite = correction.rewrites.get(passage);
        const range = correction.sessionId ? { ...span, session: correction.sessionId } : span;
        ranges.push(
          rewrite
            ? { ...range, rewrite: { to: span.from + rewrite.rawTo, text: rewrite.text } }
            : range
        );
      }
    }
    for (const rewrite of this.pendingRewrites) {
      if (rewrite.panelId !== panelId) continue;
      const range = rewrite.selection.range();
      if (range) ranges.push(range);
    }
    ranges.sort((a, b) => a.from - b.from);
    const voiceStore = useVoiceRecordingStore.getState();
    // A closed panel's buffer is gone; a late result mustn't bring it back.
    if (!voiceStore.panelBuffers[panelId]) return;
    voiceStore.setCorrectionRanges(panelId, ranges);
  }

  /**
   * The dictation key, or its action from anywhere else. `returnToTarget` when
   * it was the key itself: a stop then takes the person back to the
   * dictation's pane (#14791), where the palette's or an agent's leaves focus
   * alone.
   */
  async toggleFocusedPanel({
    returnToTarget = false,
  }: { returnToTarget?: boolean } = {}): Promise<void> {
    this.initialize();

    // The shortcut is a global stop: a running session ends wherever it is,
    // before focus or the lock is consulted, so the press can never move the
    // recording to whichever panel happens to own focus (#12832).
    const stopping = this.stopAnySession(returnToTarget ? { pressedHere: true } : undefined);
    if (stopping) {
      await stopping;
      return;
    }

    // Likewise a session another view owns, in another project or window: it
    // stops there, so its text stays in that view's draft (#14601).
    const elsewhere = useVoiceRecordingStore.getState().sessionElsewhere;
    if (elsewhere) {
      await this.stopSessionElsewhere(elsewhere, returnToTarget);
      return;
    }

    // Canopy covers the grid while it's open, so the key goes to the selected
    // row's reply, ahead of a lock or the assistant behind it, or nowhere.
    if (useCanopyStore.getState().isOpen) {
      await this.toggleCanopyReply();
      return;
    }

    // Locked target overrides focus routing entirely — synchronous read before
    // any await so the value reflects the user's pin at the moment the hotkey
    // fired (mirrors the assistant-focus pattern below for #6959). When the
    // locked panel has been trashed or removed, clear the stale lock and fall
    // through to normal focus-based resolution rather than failing silently.
    // A locked panel that has lost its composer (its agent exited, hybrid
    // input went off) starts nothing and keeps the lock, since the composer
    // may come back; falling through would hand the words to a pane the lock
    // was taken to keep them out of (#14955).
    const lockedTarget = useVoiceRecordingStore.getState().lockedTarget;
    if (lockedTarget) {
      const lockedPanel = usePanelStore.getState().panelsById[lockedTarget.panelId];
      if (lockedPanel && lockedPanel.location !== "trash") {
        if (!this.getDictationTarget(lockedTarget.panelId)) {
          this.reportLockedPanelUnavailable(lockedTarget);
          return;
        }
        await this.toggle(lockedTarget);
        return;
      }
      useVoiceRecordingStore.getState().clearLockedTarget(lockedTarget.panelId);
    }

    // Assistant focus is tracked by macroFocusStore, not panelStore.focusedId,
    // so check it synchronously (before any await — #6959) and route dictation
    // to the assistant when its input owns focus. Otherwise the last-active grid
    // terminal would steal the dictation (#8887).
    if (isAssistantFocused()) {
      const assistantTarget = this.getAssistantTarget();
      if (!assistantTarget) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "renderer_error",
          message: "Daintree Assistant is starting — try again in a moment.",
        });
        useVoiceRecordingStore
          .getState()
          .announce("Daintree Assistant is starting. Try dictation again in a moment.");
        this.reportStartFailure(
          "Dictation didn't start",
          "Daintree Assistant is still starting.",
          this.retryAction(() => void this.toggleFocusedPanel())
        );
        return;
      }
      await this.startOrToggle(assistantTarget);
      return;
    }

    // The Assistant counts as the place the person was last in when it is on
    // screen and they used it after the pane in question (#15870).
    const assistant = this.getAssistantFallbackTarget();
    const assistantAhead = (paneIds: Iterable<string>): boolean =>
      this.isAssistantShown() && wasAssistantUsedAfter(paneIds);

    // `focusedId` stays on the pane the person left for the Assistant (#6959),
    // so it is the focused agent only once they are back in it.
    const focusedTarget = this.getFocusedPanelTarget();
    if (focusedTarget) {
      if (assistant && assistantAhead([focusedTarget.panelId])) {
        await this.startInAssistant(assistant);
        return;
      }
      await this.startOrToggle(focusedTarget);
      return;
    }

    // Nothing focused can take it, so the agent on screen the person was just
    // in does (#15550). It comes forward with the keyboard in its composer, as
    // if it had been focused, so they see where the words go (#14770).
    // A closed Assistant opening would take the keyboard from a modal that
    // holds it, so it only comes forward without one.
    const { candidates, target } = this.getVisibleFallback();
    const assistantFallback = target
      ? assistantAhead(candidates.keys())
      : candidates.size === 0 && (this.isAssistantShown() || !overlayHoldsKeyboard());
    if (assistant && assistantFallback) {
      await this.startInAssistant(assistant);
      return;
    }
    if (!target) {
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "No focused terminal is available for dictation.",
      });
      useVoiceRecordingStore
        .getState()
        .announce("Focus an agent terminal before starting dictation.");
      this.reportStartFailure(
        "Dictation unavailable",
        "Focus an agent terminal to dictate into its input."
      );
      return;
    }

    usePanelStore.getState().activateTerminal(target.panelId);
    revealDictationComposer(target.panelId);
    await this.startOrToggle(target);
  }

  /**
   * The Assistant as the key's fallback: shown if it was closed, with the
   * keyboard in its composer, as a grid pane comes forward for #15550.
   */
  private async startInAssistant(target: VoiceRecordingTarget): Promise<void> {
    const help = useHelpPanelStore.getState();
    useFocusStore.getState().clearAssistantGesture();
    if (!help.isOpen) help.setOpen(true);
    revealAssistantComposer();
    await this.startOrToggle(target);
  }

  private reportLockedPanelUnavailable(locked: VoiceRecordingTarget): void {
    const why = `Dictation is locked to ${locked.panelTitle?.trim() || "a panel"}, which has no input to dictate into.`;
    const voiceStore = useVoiceRecordingStore.getState();
    voiceStore.setLastError({ severity: "fatal", code: "renderer_error", message: why });
    voiceStore.announce(why);
    this.reportStartFailure(
      "Dictation unavailable",
      `${why} Unlock it to dictate into the focused agent terminal.`,
      {
        label: "Unlock dictation",
        // Only this lock: one taken since the toast went up stays.
        onClick: () => useVoiceRecordingStore.getState().clearLockedTarget(locked.panelId),
      }
    );
  }

  private async toggleCanopyReply(): Promise<void> {
    const reply = resolveCanopyReplyDictation();
    if (!reply.ok) {
      useVoiceRecordingStore.getState().announce(reply.message);
      this.reportStartFailure("Dictation unavailable", reply.message);
      return;
    }
    reply.focus();
    await this.startOrToggle(reply.target);
  }

  /**
   * End whatever dictation is in progress, regardless of target. Returns null
   * when idle — synchronously, so the caller's focus and lock reads still
   * happen before any await. A pre-audio arming window with no mic open only
   * needs cancelArming(); if a stream is still open (a panel button
   * retargeting mid-session re-enters arming before tearing the old session
   * down), a full stop() is needed to release it.
   */
  private stopAnySession(withKey?: { pressedHere: boolean }): Promise<void> | null {
    const { status, pendingTarget } = useVoiceRecordingStore.getState();
    const startup = this.liveStartup();
    // Already stopped by the user and only sending its queue: the press either
    // resumes it or starts the next session.
    if (startup?.stopAfterStart) return null;
    if (startup || pendingTarget || status === "arming" || this.isStoppableSession(status)) {
      return withKey ? this.stopWithKey("user", withKey.pressedHere) : this.requestUserStop();
    }
    return null;
  }

  private async stopSessionElsewhere(
    session: VoiceSessionElsewhere,
    returnToTarget: boolean
  ): Promise<void> {
    // This press was a stop, so its release must not stop anything here.
    this.dropHeldPress();
    let stopped = false;
    try {
      stopped = await window.electron.voiceInput.stopLive({
        sessionId: session.sessionId,
        ...(returnToTarget ? { returnToTarget } : {}),
      });
    } catch (error) {
      logWarn(`${LOG_PREFIX} Couldn't stop dictation in another view`, voiceErrorLogFields(error));
    }
    // Already over: main's update that says so is on its way.
    if (!stopped) return;
    const workspace = sessionWorkspaceName(session, useScratchStore.getState().scratches);
    const hostName = namesSessionHost(session)
      ? sessionHostName(session.hostId, getHostListSnapshot().hosts)
      : null;
    useVoiceRecordingStore
      .getState()
      .announce(`Stopping dictation${sessionPlacePhrase(workspace, hostName)}.`);
  }

  // A workspace on this view's own host opens as one of its own. Another
  // host's takes the window there, where its cached view comes back with it
  // (#14773): an id on one host names nothing on another.
  private async showWorkspaceOn(hostId: HostId, workspaceId: string): Promise<void> {
    if (isSameHost(hostId, currentHostId())) {
      await this.showWorkspace(workspaceId);
      return;
    }
    try {
      const { switchToHost } = await import("@/components/Hosts/hostSwitching");
      await switchToHost(hostId, false, workspaceId);
    } catch (error) {
      logWarn(`${LOG_PREFIX} Couldn't show the dictating host`, voiceErrorLogFields(error));
    }
  }

  // Projects and scratches switch through separate stores, told apart by the
  // shape of the id.
  private async showWorkspace(workspaceId: string): Promise<void> {
    try {
      if (isScratchWorkspaceId(workspaceId)) {
        await useScratchStore.getState().switchScratch(workspaceId);
      } else {
        await useProjectStore.getState().switchProject(workspaceId);
      }
    } catch (error) {
      logWarn(`${LOG_PREFIX} Couldn't show the dictating workspace`, voiceErrorLogFields(error));
    }
  }

  /**
   * Pauses or resumes the session another view owns. Named by id, so a panel
   * still open on an ended session can't act on the one that replaced it.
   */
  async setSessionElsewherePaused(sessionId: string, paused: boolean): Promise<boolean> {
    if (useVoiceRecordingStore.getState().sessionElsewhere?.sessionId !== sessionId) return false;
    try {
      return await window.electron.voiceInput.setPausedLive({ sessionId, paused });
    } catch (error) {
      logWarn(`${LOG_PREFIX} Couldn't pause dictation in another view`, voiceErrorLogFields(error));
      return false;
    }
  }

  /** Stops the session another view owns, from this view's control panel. */
  async stopSessionElsewhereById(sessionId: string): Promise<void> {
    const session = useVoiceRecordingStore.getState().sessionElsewhere;
    if (session?.sessionId === sessionId) await this.stopSessionElsewhere(session, false);
  }

  /**
   * Takes the person to the session another view owns: its window, project and
   * panel. With `sessionId`, only while that is still the session.
   */
  async revealSessionElsewhere(sessionId?: string): Promise<boolean> {
    const session = useVoiceRecordingStore.getState().sessionElsewhere;
    if (!session || (sessionId !== undefined && session.sessionId !== sessionId)) return false;
    try {
      return await window.electron.voiceInput.revealLive(session.sessionId);
    } catch (error) {
      logWarn(`${LOG_PREFIX} Couldn't go to dictation in another view`, voiceErrorLogFields(error));
      return false;
    }
  }

  /**
   * A session a press would stop. One already finishing (or whose stop is in
   * flight) is excluded: the press starts the next session instead of joining
   * the drain and being swallowed (#14604).
   */
  private isStoppableSession(status: VoiceInputStatus): boolean {
    return isActiveVoiceSession(status) && status !== "finishing" && this.stopPromise === null;
  }

  /**
   * Toggle dictation directly into the Daintree Assistant input, regardless of
   * which panel currently owns focus (#8887). Opens the assistant if it's
   * closed; if no assistant session has launched yet (`terminalId` is null) it
   * surfaces a toast rather than silently doing nothing.
   */
  async toggleAssistant(): Promise<void> {
    this.initialize();

    const helpState = useHelpPanelStore.getState();
    if (!helpState.isOpen) {
      helpState.setOpen(true);
      helpState.requestFocus();
    }

    // setOpen only flips the visibility flag — the assistant terminal is spawned
    // on render, so terminalId may still be null here. Don't re-read it; guide
    // the user to retry once the session exists.
    const assistantTarget = this.getAssistantTarget();
    if (!assistantTarget) {
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Start the Daintree Assistant before dictating.",
      });
      useVoiceRecordingStore.getState().announce("Start the Daintree Assistant before dictating.");
      this.reportStartFailure(
        "Dictation didn't start",
        "Start the Daintree Assistant before dictating.",
        this.retryAction(() => void this.toggleAssistant())
      );
      return;
    }

    await this.startOrToggle(assistantTarget);
  }

  /**
   * Records a spoken instruction for the text selected in the composer that
   * holds the caret, then has the correction model apply it there (#14635).
   * Like the dictation key, a press while anything is recording stops it.
   */
  async rewriteSelection(): Promise<void> {
    this.initialize();
    const stopping = this.stopAnySession();
    if (stopping) {
      await stopping;
      return;
    }

    // A press after the key was released, while that rewrite's audio is still
    // queued, keeps recording into it rather than dropping what was said.
    const released = this.liveStartup();
    if (released?.stopAfterStart && released.target.rewrite) {
      if (this.resumeReleasedStartup(released.target)) this.claimHeldPress();
      return;
    }

    const source = findRewriteComposer(usePanelStore.getState().focusedId);
    const target = source ? this.getComposerTarget(source.terminalId) : null;
    if (!source || !target) {
      this.reportNothingToRewrite("Select text in an agent's prompt to rewrite it by voice.");
      return;
    }
    if (this.hasCleanupKey === false) {
      const issuer = this.cleanupKeyIssuer;
      useVoiceRecordingStore.getState().announce(`Rewriting by voice needs an ${issuer} API key.`);
      this.reportStartFailure(
        "Rewrite unavailable",
        `Add an ${issuer} API key in voice settings to rewrite selected text by voice.`,
        this.settingsAction()
      );
      return;
    }
    const selection = source.captureSelection();
    if (!selection) {
      this.reportNothingToRewrite("Select the text to rewrite, then press the shortcut again.");
      return;
    }
    if (selection.text.length > VOICE_REWRITE_MAX_SELECTION_CHARS) {
      selection.release();
      this.reportNothingToRewrite(
        "That selection is too long to rewrite. Select a shorter passage."
      );
      return;
    }

    const rewriteTarget: VoiceRecordingTarget = {
      ...target,
      rewrite: { selection, instruction: [], cancelled: false },
    };
    // The rewrite key follows the recording mode like the dictation key.
    this.claimHeldPress();
    this.armTarget(rewriteTarget);
    await this.start(rewriteTarget);
  }

  /** The pre-audio cue for a start, which supersedes any start still pending. */
  private armTarget(target: VoiceRecordingTarget): void {
    this.releasePendingRewrite(target);
    useVoiceRecordingStore.getState().setArming(target);
  }

  /**
   * A rewrite whose start is cancelled or superseded before its session began
   * gives its selection back. One whose session is running keeps it for that
   * session's stop, and `next` keeps it when the new start is the same rewrite.
   */
  private releasePendingRewrite(next?: VoiceRecordingTarget): void {
    const { pendingTarget, activeTarget, status } = useVoiceRecordingStore.getState();
    const pending = pendingTarget?.rewrite;
    if (
      !pending ||
      pending === next?.rewrite ||
      (isActiveVoiceSession(status) && activeTarget?.rewrite === pending)
    ) {
      return;
    }
    pending.selection.release();
  }

  private reportNothingToRewrite(message: string): void {
    useVoiceRecordingStore.getState().announce(message);
    notify({
      type: "info",
      title: "Nothing to rewrite",
      message,
      transient: true,
      priority: "high",
      replaceKey: "voice-rewrite",
      context: { eventKind: "uiFeedback" },
    });
  }

  // The panel whose composer holds the selection: the assistant's own when it
  // is the assistant's, whatever dictation is locked to.
  private getComposerTarget(terminalId: string): VoiceRecordingTarget | null {
    if (selectActiveSlot(useHelpPanelStore.getState()).terminalId === terminalId) {
      return this.getAssistantTarget();
    }
    return this.getDictationTarget(terminalId);
  }

  // In push-to-talk mode the keyboard shortcut starts recording; the keyup
  // listener stops it. Tap-or-hold goes through toggle(), and only the release
  // of a press toggle() claimed can stop it. But the same action is also reachable from the command
  // palette, the menu, and agent automation — none of which produce a keyup.
  // Falling back to stop-on-second-invoke for an active session of the same
  // target keeps those entry points usable without affecting the held-key
  // flow (a held-key second press is suppressed by the e.repeat guard, and a
  // release-then-press cycle has already cleared the active session).
  // In toggle mode the shortcut behaves as before. Toolbar callers should
  // keep using `toggle()` directly — they have no keyup analog and must not
  // be affected by the recording-mode setting.
  private async startOrToggle(target: VoiceRecordingTarget): Promise<void> {
    if (this.recordingMode === "push-to-talk") {
      if (this.resumeReleasedStartup(target)) {
        this.claimHeldPress();
        return;
      }
      const state = useVoiceRecordingStore.getState();
      if (state.pendingTarget?.panelId === target.panelId) {
        if (!this.deferStopToStartup("user")) this.cancelArming("user");
        return;
      }
      const isActiveTarget = state.activeTarget?.panelId === target.panelId;
      if (isActiveTarget && this.isStoppableSession(state.status)) {
        await this.requestUserStop();
        return;
      }
      // The held key gets the same pre-audio cue as a toggle press.
      useVoiceRecordingStore.getState().recordRecentTarget(target);
      this.claimHeldPress();
      focusDictationComposer(target.panelId);
      this.armTarget(target);
      await this.start(target);
      return;
    }
    await this.toggle(target);
  }

  /**
   * Another view's indicator asked for this view's session: its window is
   * coming back to it, from another project or another host.
   */
  private revealOwnTarget(): void {
    // Whatever the toolbar names once the view is shown: a start may have
    // replaced the session meanwhile.
    this.revealTarget(
      () => {
        const { pendingTarget, activeTarget } = useVoiceRecordingStore.getState();
        return pendingTarget ?? activeTarget;
      },
      (target) => revealDictationComposer(target.panelId)
    );
  }

  /**
   * Once this view is on screen, the target `resolve` names comes forward and
   * `focusComposer` puts the keyboard in its composer (#14770): for the
   * indicator's "go there" (#14773), or the dictation key that stopped it
   * (#14791), which `isCurrent` calls off once the person has moved on. A
   * cached view waits to be shown, and gives up if it isn't.
   */
  private revealTarget(
    resolve: () => VoiceRecordingTarget | null,
    focusComposer: (target: VoiceRecordingTarget) => void,
    isCurrent: () => boolean = () => true
  ): void {
    this.cancelRevealWait?.();
    this.cancelRevealWait = null;
    const reveal = () => {
      const target = resolve();
      if (!target || !isCurrent()) return;
      void this.focusActiveTarget(target, isCurrent).then((found) => {
        // A Canopy reply put the keyboard in itself.
        if (found && !isCanopyReplyTarget(target)) focusComposer(target);
      });
    };
    if (!isProjectViewCached()) {
      reveal();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      if (this.cancelRevealWait === cancel) this.cancelRevealWait = null;
    };
    unsubscribe = subscribeProjectViewLifecycle((phase) => {
      // Cached again before it was shown: the person went somewhere else, and
      // a later return of theirs is not this reveal.
      if (phase === "cached") cancel();
      if (phase !== "revealed") return;
      cancel();
      reveal();
    });
    timer = setTimeout(cancel, REVEAL_FOCUS_WAIT_MS);
    this.cancelRevealWait = cancel;
  }

  /**
   * Brings a dictation's pane forward, switching project and worktree as
   * needed: `target`, or else the one the toolbar names. `isCurrent` calls it
   * off after any wait, once the person has moved on.
   */
  async focusActiveTarget(
    target?: VoiceRecordingTarget,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    this.initialize();
    // A queued start is what the toolbar names, so it is where a click goes.
    const { pendingTarget, activeTarget } = useVoiceRecordingStore.getState();
    target ??= pendingTarget ?? activeTarget ?? undefined;
    if (!target) return false;

    // Its row, wherever Canopy is now: already in front, the keyboard goes
    // into its reply; otherwise Canopy opens on it (#14778).
    if (isCanopyReplyTarget(target)) {
      const reply = useCanopyStore.getState().isOpen ? resolveCanopyReplyDictation() : null;
      if (reply?.ok && reply.target.panelId === target.panelId) {
        reply.focus();
        return true;
      }
      return (
        target.canopyRow !== undefined && useCanopyStore.getState().revealReply(target.canopyRow)
      );
    }

    const currentProjectId = useProjectStore.getState().currentProject?.id;
    if (target.projectId && currentProjectId !== target.projectId) {
      await useProjectStore.getState().switchProject(target.projectId);
      if (!isCurrent()) return false;
    }

    if (target.worktreeId) {
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      if (activeWorktreeId !== target.worktreeId) {
        useWorktreeSelectionStore.getState().selectWorktree(target.worktreeId);
      }
    }

    await this.waitForPanel(target.panelId);

    const foundPanel = usePanelStore.getState().panelsById[target.panelId];
    if (!foundPanel || foundPanel.location === "trash" || !isCurrent()) {
      return false;
    }
    const panel = foundPanel;

    usePanelStore.getState().activateTerminal(panel.id);
    return true;
  }

  /**
   * The composer dictation would start in without a lock: the assistant's
   * while it has focus (or `assistant` says it's the one meant), else the
   * focused agent's. Null when that one has no composer.
   */
  getFocusedComposerTarget(assistant = isAssistantFocused()): VoiceRecordingTarget | null {
    return assistant ? this.getAssistantTarget() : this.getFocusedPanelTarget();
  }

  private getFocusedPanelTarget(): VoiceRecordingTarget | null {
    const panelId = usePanelStore.getState().focusedId;
    return panelId ? this.getDictationTarget(panelId) : null;
  }

  /**
   * The panes on screen that can take dictation, and of them the one most
   * recently focused, else the only one. No target when there is none, or
   * several and none was focused.
   */
  private getVisibleFallback(): {
    candidates: ReadonlyMap<string, VoiceRecordingTarget>;
    target: VoiceRecordingTarget | null;
  } {
    const panels = usePanelStore.getState();
    const { activeWorktreeId, isFleetScopeActive } = useWorktreeSelectionStore.getState();
    const closing = getClosingIds();
    // A fleet scope draws every worktree's armed panels in place of this
    // worktree's grid; its cells are left to the focused path.
    const fleetDrawn =
      isFleetScopeActive &&
      useFleetScopeFlagStore.getState().mode === "scoped" &&
      buildFleetPanels(
        useFleetArmingStore.getState().armOrder,
        useFleetArmingStore.getState().armedIds,
        panels.panelsById
      ).some((panel) => !closing.has(panel.id));

    const visibleIds = listVisiblePaneIds({
      panelIds: panels.panelIds,
      panelsById: panels.panelsById,
      activeDockTerminalId: panels.activeDockTerminalId,
      trashedTerminals: panels.trashedTerminals,
      activeWorktreeId,
      maximizedId: panels.maximizedId,
      maximizeTarget: panels.maximizeTarget,
      gridGroups: panels.getTabGroups("grid", activeWorktreeId ?? undefined),
      helpTerminalIds: new Set(selectSlotTerminalIds(useHelpPanelStore.getState())),
      gridHidden: isProjectHomePresented() || fleetDrawn,
      isClosing: (id) => closing.has(id),
    });

    const targets = new Map<string, VoiceRecordingTarget>();
    for (const id of visibleIds) {
      const target = this.getDictationTarget(id);
      if (target) targets.set(id, target);
    }
    return { candidates: targets, target: pickRecentVisibleTarget(targets, panels.mruList) };
  }

  /** The pane as a dictation target, or null when it has no composer to show the words. */
  getDictationTarget(panelId: string): VoiceRecordingTarget | null {
    const panel = usePanelStore.getState().panelsById[panelId];
    if (!panel) return null;
    const armed = useFleetArmingStore.getState().armedIds;
    if (
      !panelHasComposer(panel, {
        hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
        isFleetArmed: armed.has(panelId),
        fleetSize: armed.size,
      })
    ) {
      return null;
    }

    const currentProject = useProjectStore.getState().currentProject;
    const worktree = panel.worktreeId
      ? getCurrentViewStore().getState().worktrees.get(panel.worktreeId)
      : undefined;

    return {
      panelId: panel.id,
      panelTitle: panel.title,
      projectId: currentProject?.id,
      projectName: currentProject?.name,
      worktreeId: panel.worktreeId,
      worktreeLabel: worktree?.isMainWorktree ? worktree?.name : worktree?.branch || worktree?.name,
    };
  }

  private getAssistantTarget(): VoiceRecordingTarget | null {
    // The ACTIVE lane (#12108): dictation is aimed at the session on screen,
    // not at whichever one happens to be running in the background.
    const terminalId = selectActiveSlot(useHelpPanelStore.getState()).terminalId;
    if (!terminalId) return null;

    // Guard the brief window where the assistant terminal has been trashed (or
    // not yet committed to panelStore) but helpPanelStore.terminalId is still
    // set — mirrors getFocusedPanelTarget(). A missing/trashed panel means the
    // assistant is starting or tearing down, so dictation must not target it.
    const panelEntry = usePanelStore.getState().panelsById[terminalId];
    if (!panelEntry || panelEntry.location === "trash") return null;

    const currentProject = useProjectStore.getState().currentProject;
    return {
      panelId: terminalId,
      panelTitle: "Daintree Assistant",
      projectId: currentProject?.id,
      projectName: currentProject?.name,
    };
  }

  /**
   * The Assistant the key may fall back to (#15870): the active lane's
   * session, already running and showing a composer that can take the words.
   * Never one still starting, and never while the panel shows the global
   * assistant in place of the lane, where the words would go somewhere nobody
   * can see.
   */
  private getAssistantFallbackTarget(): VoiceRecordingTarget | null {
    const help = useHelpPanelStore.getState();
    if (help.globalSelected) return null;
    const target = this.getAssistantTarget();
    if (!target) return null;
    const panel = usePanelStore.getState().panelsById[target.panelId];
    if (!panel || !isPtyPanel(panel) || panel.isInputLocked === true) return null;
    // A reconnected terminal carries no status; one still spawning (or held
    // for memory or a drive lease) isn't running yet.
    if (panel.spawnStatus !== undefined && panel.spawnStatus !== "ready") return null;
    // The composer as the Assistant renders it, from the lane's agent.
    const hasComposer = shouldShowHybridInputBar({
      hasAgentIdentity: isBuiltInAgentId(selectActiveSlot(help).agentId),
      hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
      isFleetArmed: false,
      fleetSize: 0,
    });
    return hasComposer ? target : null;
  }

  /** The Assistant panel on screen: open, and not hidden by the focus gesture. */
  private isAssistantShown(): boolean {
    return useHelpPanelStore.getState().isOpen && !useFocusStore.getState().gestureAssistantHidden;
  }

  private async waitForPanel(panelId: string, timeoutMs = 5000): Promise<void> {
    const existingPanel = usePanelStore.getState().panelsById[panelId];
    if (existingPanel && existingPanel.location !== "trash") return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      }, timeoutMs);

      const unsubscribe = usePanelStore.subscribe((state) => {
        const found = state.panelsById[panelId];
        if (!found || found.location === "trash" || settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
  }

  /**
   * An utterance of a dictation whose draft another screen drives: kept with
   * the session's words for Recent dictations, never written, and never a
   * command. A scratch has nothing here to take back, so it's only dropped.
   */
  private keepDetachedWords(
    panelId: string,
    sessionId: string,
    text: string,
    itemId: string | undefined,
    send: boolean | undefined
  ): void {
    if (send) {
      logVoiceSendRefused({
        asker: "spoken_send",
        reason: "composer_disabled",
        panelId,
        sessionId,
      });
    }
    const spoken = text.trim();
    if (spoken && isScratchCommand(spoken)) {
      useVoiceRecordingStore.getState().completeSegment("", itemId, { discard: true });
      return;
    }
    if (!spoken && !itemId) return;
    useVoiceRecordingStore.getState().completeSegment(text, itemId);
  }

  /**
   * Another screen took control of the project a dictation writes into (#15919).
   * Its drafts are the driver's now: nothing written here is saved, and the
   * driver's replace it. The session ends, what it heard kept for Recent
   * dictations rather than written, and nothing already on its way (a
   * cleanup, a rewrite, a file link) lands in those drafts.
   */
  private followDriveLease(): void {
    if (getLeaseInputBlock()?.kind !== "driven-elsewhere") return;
    this.dropDrivenDraftWork();

    // A start waiting behind another session has no session of its own to stop.
    const { pendingTarget, activeTarget: sessionTarget } = useVoiceRecordingStore.getState();
    const pendingDriven = pendingTarget ? drivenElsewhereFor(pendingTarget.projectId) : null;
    if (pendingDriven && pendingTarget!.panelId !== sessionTarget?.panelId) {
      this.cancelArming("lease_lost");
      this.reportDrivenStart(pendingDriven);
    }

    const state = useVoiceRecordingStore.getState();
    const target = state.activeTarget;
    const driven = target ? drivenElsewhereFor(target.projectId) : null;
    if (!target || !driven) return;
    if (state.status === "arming") {
      this.cancelArming("lease_lost");
      this.reportDrivenStart(driven);
      return;
    }
    if (!isActiveVoiceSession(state.status)) return;
    const buffer = state.panelBuffers[target.panelId];
    const sessionId = buffer?.dictationSessionId;
    if (!sessionId || state.draftDetachedSessionId === sessionId) return;
    state.detachSessionDraft(sessionId);
    useDictationRangeStore.getState().releaseAnchors(sessionId);
    logInfo(`${LOG_PREFIX} Another screen took control of the dictation's project`, {
      status: state.status,
      stopping: this.stopPromise !== null,
    });
    if (target.rewrite) {
      // Its stop gives the selection back as it was.
      this.reportRewriteSkipped(
        `${controllerName(driven)} has control of this project, so the selection wasn't rewritten.`
      );
    } else {
      this.reportDrivenStop(
        driven,
        buffer.completedSegments.length > 0 || buffer.liveText.trim() !== ""
      );
    }
    // A stop already draining ends the session; it writes nothing more now.
    if (this.stopPromise) return;
    void this.stop(
      `Dictation stopped because ${controllerName(driven)} has control of this project.`,
      { preserveLiveText: true, reason: "lease_lost" }
    );
  }

  /**
   * Lets go of every dictated range in a draft another screen drives, and the
   * cleanups and rewrites aimed at them: they would land in text that is the
   * driver's now. A cleanup's reply is still kept for Recent dictations.
   */
  private dropDrivenDraftWork(): void {
    const ranges = useDictationRangeStore.getState();
    for (const records of Object.values(ranges.drafts)) {
      for (const record of records) {
        if (drivenElsewhereFor(record.projectId)) ranges.releaseDictation(record.id);
      }
    }
    const panels = new Set<string>();
    for (const correction of this.pendingCorrections) {
      if (drivenElsewhereFor(correction.projectId)) panels.add(correction.panelId);
    }
    let rewriteDropped: DrivenElsewhere | null = null;
    for (const rewrite of this.pendingRewrites) {
      const driven = drivenElsewhereFor(rewrite.projectId);
      if (!driven) continue;
      panels.add(rewrite.panelId);
      rewriteDropped = driven;
    }
    for (const panelId of panels) this.discardPendingCorrections(panelId);
    if (rewriteDropped) {
      this.reportRewriteSkipped(
        `${controllerName(rewriteDropped)} has control of this project, so the selection wasn't rewritten.`
      );
    }
  }

  private reportDrivenStop(driven: DrivenElsewhere, keptWords: boolean): void {
    const controls = `${controllerName(driven)} has control of this project.`;
    notify({
      type: "info",
      placement: "grid-bar",
      title: "Dictation stopped",
      message: keptWords ? `${controls} What you said is in Recent dictations.` : controls,
      priority: "high",
      replaceKey: "voice-drive-lease",
      context: { eventKind: "recovery" },
      ...(keptWords
        ? {
            action: {
              label: "Open recent dictations",
              actionId: "voiceInput.openRecentDictations" as const,
              onClick: () => this.openRecentDictations(),
            },
          }
        : {}),
    });
  }

  /** Feedback on the user's own press: the composer already shows it is read-only. */
  private reportDrivenStart(driven: DrivenElsewhere): void {
    const message = `${controllerName(driven)} has control of this project.`;
    useVoiceRecordingStore.getState().announce(`Dictation didn't start. ${message}`);
    notify({
      type: "info",
      title: "Dictation didn't start",
      message,
      transient: true,
      priority: "high",
      replaceKey: "voice-drive-lease",
      context: { eventKind: "uiFeedback" },
    });
  }

  private openRecentDictations(): void {
    safeFireAndForget(
      import("@/services/ActionService").then(({ actionService }) =>
        actionService.dispatch("voiceInput.openRecentDictations", undefined, { source: "user" })
      ),
      { context: "Opening recent dictations" }
    );
  }

  private async handleSuspend(): Promise<void> {
    // The audio devices may not be the same ones after wake.
    this.retireWarmAudio();
    if (!useVoiceRecordingStore.getState().activeTarget) return;
    await this.stop("Dictation stopped because the system is going to sleep.", {
      preserveLiveText: true,
      reason: "sleep",
    });
  }

  private startElapsedTimer(): void {
    this.clearElapsedTimer();
    useVoiceRecordingStore.getState().setElapsedSeconds(this.computeElapsedSeconds());
    this.elapsedTimer = setInterval(() => {
      useVoiceRecordingStore.getState().setElapsedSeconds(this.computeElapsedSeconds());
    }, 1000);
  }

  private computeElapsedSeconds(): number {
    const wallMs = Date.now() - this.sessionStartedAt;
    return Math.max(0, Math.floor((wallMs - this.totalPausedMs) / 1000));
  }

  private clearElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }

  private clearPauseTimeout(): void {
    this.pauseStopsAt = null;
    if (this.pauseWarnTimeoutId !== null) {
      clearTimeout(this.pauseWarnTimeoutId);
      this.pauseWarnTimeoutId = null;
    }
    if (useVoiceRecordingStore.getState().pauseStopWarning) {
      useVoiceRecordingStore.getState().setPauseStopWarning(false);
    }
    if (this.pauseTimeoutId === null) return;
    clearTimeout(this.pauseTimeoutId);
    this.pauseTimeoutId = null;
  }

  private clearIdleTimeout(): void {
    this.idleStopsAt = null;
    if (this.idleWarnTimeoutId !== null) {
      clearTimeout(this.idleWarnTimeoutId);
      this.idleWarnTimeoutId = null;
    }
    if (this.idleTimeoutId !== null) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (useVoiceRecordingStore.getState().idleStopWarning) {
      useVoiceRecordingStore.getState().setIdleStopWarning(false);
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimeout();
    this.idleStopsAt = Date.now() + VoiceRecordingService.IDLE_AUTO_STOP_MS;
    this.idleWarnTimeoutId = setTimeout(() => {
      this.idleWarnTimeoutId = null;
      const current = useVoiceRecordingStore.getState();
      if (!current.activeTarget || current.status === "paused") return;
      current.setIdleStopWarning(true);
      current.announce("Dictation stops in 10 seconds unless you speak.");
    }, VoiceRecordingService.IDLE_AUTO_STOP_MS - VoiceRecordingService.IDLE_WARN_LEAD_MS);
    this.idleTimeoutId = setTimeout(() => {
      this.idleTimeoutId = null;
      // Re-read the store: the session may have paused or ended since (#5087).
      const current = useVoiceRecordingStore.getState();
      if (!current.activeTarget || current.status === "paused") return;
      logInfo(`${LOG_PREFIX} Auto-stopping after 3 minutes without new words`);
      notify({
        type: "info",
        title: "Dictation stopped",
        message: "No new words for 3 minutes. What you said is in the draft.",
        priority: "high",
        context: { eventKind: "uiFeedback" },
      });
      void this.stop("Dictation stopped after 3 minutes without new words.", {
        preserveLiveText: true,
        reason: "idle_timeout",
      });
    }, VoiceRecordingService.IDLE_AUTO_STOP_MS);
  }

  // Only a live session has a clock; a late delta after stop must not arm one.
  private noteWordsHeard(): void {
    if (this.idleTimeoutId === null) return;
    this.startIdleTimer();
  }

  // Main applies the user's sound settings and volume, so this stays unconditional.
  private playCue(id: "dictation-start" | "dictation-stop" | "dictation-error"): void {
    window.electron?.notification?.playUiEvent?.(id)?.catch(() => {});
  }

  private markMicLive(target: VoiceRecordingTarget, chunkCount: number): void {
    this.clearMicSilenceTimer();
    const state = useVoiceRecordingStore.getState();
    logInfo(`${LOG_PREFIX} Microphone delivering audio`, {
      chunk: chunkCount,
      msSinceCaptureAttach: Math.round(performance.now() - this.micCaptureAttachedAt),
      wasSilent: state.micSignal === "silent",
    });
    state.setMicSignal("live");
    this.playCue("dictation-start");
    // The stand-in mic is still the one recording once it is heard.
    if (state.micNotice?.kind === "silent") state.setMicNotice(this.displacedFallbackNotice);
    this.displacedFallbackNotice = null;
    const capture = this.sessionCapture;
    const fallbackMic = capture?.substituted ? (capture.deviceLabel ?? "another microphone") : null;
    state.announce(
      fallbackMic
        ? `Dictation started in ${formatTargetLabel(target)}, using ${fallbackMic}.`
        : `Dictation started in ${formatTargetLabel(target)}.`
    );
  }

  private startMicSilenceTimer(
    generation: number,
    startRequestId: number,
    delayMs: number = VoiceRecordingService.MIC_SILENCE_GRACE_MS
  ): void {
    this.clearMicSilenceTimer();
    this.micSilenceSession = { generation, startRequestId };
    this.micSilenceTimeoutId = setTimeout(() => {
      this.micSilenceTimeoutId = null;
      if (this.generation !== generation || this.isStartRequestStale(startRequestId)) return;
      const state = useVoiceRecordingStore.getState();
      // Paused (or finishing) before the mic came up: the worklet isn't
      // forwarding, so the absence of audio says nothing about the mic.
      if (state.micSignal !== "pending" || !isVoiceMicPending(state)) return;
      logWarn(`${LOG_PREFIX} No audio from microphone after grace window`, {
        graceMs: VoiceRecordingService.MIC_SILENCE_GRACE_MS,
        chunkCount: this.sessionChunkCount,
        peakRms: Number(this.sessionPeakRms.toFixed(4)),
      });
      state.setMicSignal("silent");
      const deviceLabel = this.sessionCapture?.deviceLabel ?? null;
      state.announce(
        deviceLabel ? `No audio from ${deviceLabel} yet.` : "No audio from the microphone yet."
      );
      void this.raiseSilentMicNotice(generation);
    }, delayMs);
  }

  /**
   * Shows the silent-mic warning in the pane, offering the built-in mic when
   * there is one other than the silent mic. When the app's bundle was replaced
   * since launch (#14937), the warning offers a restart instead: macOS denies
   * the mic to the old process, so every mic is as silent as this one. Each
   * answer is dropped if the session moved on, began stopping, or the mic came
   * alive while it was read.
   */
  private async raiseSilentMicNotice(generation: number): Promise<void> {
    const capture = this.sessionCapture;
    const target = useVoiceRecordingStore.getState().activeTarget;
    if (!capture || !target) return;
    const { deviceId, deviceLabel } = capture;
    const isStale = (state: ReturnType<typeof useVoiceRecordingStore.getState>) =>
      this.generation !== generation ||
      this.sessionCapture !== capture ||
      this.stopPromise !== null ||
      state.status === "finishing" ||
      state.micSignal !== "silent" ||
      state.micNotice?.kind === "lost";
    const bluetooth = isBluetoothMicLabel(deviceLabel);
    // Listed alongside the bundle check, but only waited on when the mic
    // advice is the answer.
    const builtInMic = this.findOtherBuiltInMic(deviceId, deviceLabel);

    if (await this.isAppReplaced()) {
      const state = useVoiceRecordingStore.getState();
      if (isStale(state)) return;
      logWarn(`${LOG_PREFIX} Silent microphone after the app bundle was replaced`);
      this.displaceFallbackNotice(state.micNotice);
      state.setMicNotice({
        kind: "silent",
        target,
        deviceLabel,
        bluetooth,
        builtIn: null,
        appReplaced: true,
      });
      state.announce("Daintree was updated while running and needs a restart.");
      return;
    }

    const builtIn = await builtInMic;
    const state = useVoiceRecordingStore.getState();
    if (isStale(state)) return;
    this.displaceFallbackNotice(state.micNotice);
    state.setMicNotice({ kind: "silent", target, deviceLabel, bluetooth, builtIn });
  }

  // The silent warning takes the pane's one notice slot; a stand-in notice it
  // covers comes back once the mic is heard, unless it was dismissed first.
  private displaceFallbackNotice(notice: VoiceMicNotice | null): void {
    if (notice?.kind === "fallback") this.displacedFallbackNotice = notice;
  }

  private async findOtherBuiltInMic(
    deviceId: string | null,
    deviceLabel: string | null
  ): Promise<VoiceMicDevice | null> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const candidate = findBuiltInMic(devices.filter((device) => device.kind === "audioinput"));
      if (candidate && candidate.deviceId !== deviceId && candidate.label !== deviceLabel) {
        return candidate;
      }
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not list microphones`, voiceErrorLogFields(err));
    }
    return null;
  }

  // Unknown reads as not replaced, so the mic advice stands.
  private async isAppReplaced(): Promise<boolean> {
    try {
      return (await window.electron.voiceInput.isAppReplaced()) === true;
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not check the app bundle`, voiceErrorLogFields(err));
      return false;
    }
  }

  // The saved id went stale and the mic's name found it again: save the id it
  // has now, so settings list it as connected and the next start goes straight
  // to it. Only over the same saved choice, never one made while it opened.
  private async rememberRelocatedMic(staleId: string, deviceId: string): Promise<void> {
    try {
      const saved = await window.electron.voiceInput.getSettings();
      if (saved.deviceId !== staleId) return;
      await window.electron.voiceInput.setSettings({ deviceId });
      if (this.selectedDeviceId === staleId) this.selectedDeviceId = deviceId;
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not save the relocated microphone`, voiceErrorLogFields(err));
    }
  }

  /**
   * The silent-mic notice's way forward: make the built-in mic the dictation
   * mic, then restart the session it was raised for on it. The restart is a
   * retarget onto the same pane, so the new mic records while the silent
   * session drains. A paused session, or one held open by a push-to-talk key,
   * only has the choice saved: restarting would resume it, or outlive the
   * key's release.
   */
  async switchToMicFromNotice(notice: VoiceMicNotice): Promise<void> {
    if (notice.kind !== "silent" || !notice.builtIn || this.isSwitchingMic) return;
    if (useVoiceRecordingStore.getState().micNotice !== notice) return;
    const builtIn = notice.builtIn;
    const generation = this.generation;
    this.isSwitchingMic = true;
    try {
      try {
        await window.electron.voiceInput.setSettings({
          deviceId: builtIn.deviceId,
          deviceLabel: builtIn.label,
        });
      } catch (err) {
        logWarn(`${LOG_PREFIX} Could not save the microphone choice`, voiceErrorLogFields(err));
        useVoiceRecordingStore.getState().announce("Couldn't switch the microphone.");
        return;
      }
      this.selectedDeviceId = builtIn.deviceId;
      this.selectedDeviceLabel = builtIn.label;
      const state = useVoiceRecordingStore.getState();
      // The choice is saved either way; only the session the notice belongs
      // to is restarted, and only while it is still running.
      if (
        this.generation !== generation ||
        this.stopPromise ||
        state.activeTarget?.panelId !== notice.target.panelId ||
        !isActiveVoiceSession(state.status)
      ) {
        return;
      }
      if (state.status === "paused" || this.heldPress?.claimed) {
        state.dismissMicNotice(notice);
        state.announce(`${builtIn.label} will be used from the next dictation.`);
        return;
      }
      logInfo(`${LOG_PREFIX} Restarting dictation on the built-in microphone`);
      await this.start(state.activeTarget);
    } finally {
      this.isSwitchingMic = false;
    }
  }

  private clearMicSilenceTimer(): void {
    if (this.micSilenceTimeoutId === null) return;
    clearTimeout(this.micSilenceTimeoutId);
    this.micSilenceTimeoutId = null;
  }

  // A superseded start must not cancel a newer session's countdown.
  private clearMicSilenceTimerFor(generation: number, startRequestId: number): void {
    const owner = this.micSilenceSession;
    if (!owner || owner.generation !== generation || owner.startRequestId !== startRequestId) {
      return;
    }
    this.clearMicSilenceTimer();
    this.micSilenceSession = null;
  }

  /** Forgets where the live session might cut its next chunk. */
  private resetChunking(): void {
    this.chunkBreak = null;
    this.lastWordsAt = null;
    this.fileLinksDue.clear();
  }

  private clearTimers(): void {
    this.clearCancelConfirm();
    this.sessionClockRunning = false;
    this.clearElapsedTimer();
    this.clearPauseTimeout();
    this.clearIdleTimeout();
    this.clearMicSilenceTimer();
    useVoiceRecordingStore.getState().setElapsedSeconds(0);
  }

  /**
   * Suspend audio capture without tearing down the OpenAI Realtime session.
   * The PCM worklet stops forwarding chunks, the elapsed counter freezes, and
   * a 60-second auto-stop timer prevents the session from idling forever.
   * No-op unless the current status is "recording" — paused-on-paused, resume
   * on idle, and pause during connect/reconnect/finish are all ignored.
   */
  pause(): void {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    if (state.status !== "recording") {
      logDebug(`${LOG_PREFIX} pause() ignored`, { status: state.status });
      return;
    }
    logDebug(`${LOG_PREFIX} Pausing dictation`);
    this.workletNode?.port.postMessage({ type: "setPaused", value: true });
    this.pauseStartedAt = Date.now();
    this.clearElapsedTimer();
    // The worklet stops forwarding while paused, so no audio says nothing
    // about the mic — the grace window only counts unpaused capture.
    this.clearMicSilenceTimer();
    this.clearIdleTimeout();
    state.setStatus("paused");
    state.announce("Dictation paused.");
    this.clearPauseTimeout();
    this.pauseStopsAt = this.pauseStartedAt + VoiceRecordingService.PAUSE_AUTO_STOP_MS;
    this.pauseWarnTimeoutId = setTimeout(() => {
      this.pauseWarnTimeoutId = null;
      const current = useVoiceRecordingStore.getState();
      if (current.status !== "paused") return;
      current.setPauseStopWarning(true);
      current.announce("Dictation stops in 10 seconds unless resumed.");
    }, VoiceRecordingService.PAUSE_AUTO_STOP_MS - VoiceRecordingService.PAUSE_WARN_LEAD_MS);
    this.pauseTimeoutId = setTimeout(() => {
      this.pauseTimeoutId = null;
      // Re-read status inside the callback — the session may have ended,
      // been resumed, or even restarted on another panel between pause and
      // timeout (#5087 pattern: never close over store state in timers).
      const current = useVoiceRecordingStore.getState();
      if (current.status !== "paused") return;
      logInfo(`${LOG_PREFIX} Auto-stopping after 60s pause`);
      void this.stop("Dictation stopped after 60-second pause.", {
        preserveLiveText: true,
        reason: "pause_timeout",
      });
    }, VoiceRecordingService.PAUSE_AUTO_STOP_MS);
  }

  /**
   * Resume audio capture after a pause. Re-enables the worklet PCM pipeline,
   * accumulates the paused duration into the elapsed-time offset so the
   * displayed counter reflects only speaking time, and clears the auto-stop
   * timer. No-op unless the current status is "paused".
   */
  resume(): void {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    if (state.status !== "paused") {
      logDebug(`${LOG_PREFIX} resume() ignored`, { status: state.status });
      return;
    }
    logDebug(`${LOG_PREFIX} Resuming dictation`);
    this.clearPauseTimeout();
    if (this.pauseStartedAt > 0) {
      this.totalPausedMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = 0;
    }
    this.workletNode?.port.postMessage({ type: "setPaused", value: false });
    state.setStatus("recording");
    this.startElapsedTimer();
    this.startIdleTimer();
    // Resuming before the mic ever went live must not invite the user to speak
    // into zeros; the first real chunk announces the start instead.
    if (state.micSignal === "live") {
      state.announce("Dictation resumed.");
    } else {
      const silenceSession = this.micSilenceSession;
      if (
        state.micSignal === "pending" &&
        silenceSession &&
        silenceSession.generation === this.generation
      ) {
        this.startMicSilenceTimer(silenceSession.generation, silenceSession.startRequestId);
      }
    }
  }

  /**
   * The running session's clock for the session panel (#14920): wall time
   * since it began, pauses included, how much of that was paused, and the
   * auto-stop that would end it next. Null once the session is stopping.
   */
  getSessionClock(now = Date.now()): VoiceSessionClock | null {
    if (!this.sessionClockRunning) return null;
    const pausedMs = this.totalPausedMs + (this.pauseStartedAt > 0 ? now - this.pauseStartedAt : 0);
    const autoStop =
      this.pauseStopsAt !== null
        ? { reason: "pause" as const, remainingMs: Math.max(0, this.pauseStopsAt - now) }
        : this.idleStopsAt !== null
          ? { reason: "idle" as const, remainingMs: Math.max(0, this.idleStopsAt - now) }
          : null;
    return {
      provider: this.sessionProvider,
      elapsedMs: Math.max(0, now - this.sessionStartedAt),
      pausedMs: Math.max(0, pausedMs),
      autoStop,
    };
  }

  /**
   * The session panel's Stop: the dictation key's stop for whatever this view
   * is recording, taking the person back to it as the key does (#14791), and
   * nothing when there is nothing left to stop, so a late click can't start
   * another session. Settings' mic test stops it without going there (#14951).
   */
  stopActiveSession({ returnToTarget = true }: { returnToTarget?: boolean } = {}): Promise<void> {
    this.initialize();
    return (
      this.stopAnySession(returnToTarget ? { pressedHere: true } : undefined) ?? Promise.resolve()
    );
  }

  /**
   * Stop and send, staying where the person is: the session panel's Send and
   * its key. Its composer sends as Enter would. Without one mounted to send
   * from, the dictation still stops and its words stay in the draft; another
   * view's session stops there. With no dictation left to send, a send it
   * started that still waits on its cleanup goes as the words stand, as a
   * second Enter sends one Enter started (#15705); a drain still finishing is
   * left to finish, never stopped again. Whatever stops short of handing the
   * composer the send leaves one line in the log saying why (#15704).
   */
  async stopAndSend({
    asker = "stop_and_send_key",
  }: { asker?: VoiceStopAndSendAsker } = {}): Promise<void> {
    this.initialize();
    const unsent = this.dispatchActiveSessionSend(asker);
    if (unsent === null) return;
    if (sendWaitingStopAndSends()) return;
    // Read before the stop moves the store on.
    const { activeTarget, status, sessionElsewhere } = useVoiceRecordingStore.getState();
    const panelId = activeTarget?.panelId ?? null;
    // A start still arming had nothing to send, so its cancel says nothing.
    const hadWords = isActiveVoiceSession(status);
    const stopping = this.stopAnySession();
    if (stopping) {
      logVoiceSendRefused({ asker, reason: unsent, panelId });
      await stopping;
      if (!hadWords) return;
      notify({
        type: "info",
        title: "Dictation stopped",
        message:
          "Its prompt wasn't sent: the composer isn't open here. The words are in its draft.",
        context: { eventKind: "uiFeedback" },
      });
      return;
    }
    if (sessionElsewhere) {
      logVoiceSendRefused({
        asker,
        reason: "session_elsewhere",
        panelId: null,
        sessionId: sessionElsewhere.sessionId,
      });
      await this.stopSessionElsewhere(sessionElsewhere, false);
      return;
    }
    logVoiceSendRefused({ asker, reason: unsent, panelId });
  }

  /**
   * The session panel's way to the dictation: its pane comes forward with the
   * keyboard in its composer, or Canopy's reply takes it.
   */
  async goToActiveTarget(): Promise<void> {
    const target = useVoiceRecordingStore.getState().activeTarget;
    if (!target) return;
    // A project switch can take a while; a pane the person picks meanwhile
    // keeps the keyboard.
    const epoch = captureFocusEpoch();
    const isCurrent = () => isFocusEpochCurrent(epoch);
    const found = await this.focusActiveTarget(target, isCurrent);
    if (found && isCurrent() && !isCanopyReplyTarget(target)) {
      revealDictationComposer(target.panelId);
    }
  }

  /**
   * Toggle between recording and paused. No-op when no session is active or
   * the session is in a transitional phase (connecting, reconnecting, finishing).
   */
  togglePause(): void {
    const { status, sessionElsewhere } = useVoiceRecordingStore.getState();
    if (status === "recording") {
      this.pause();
    } else if (status === "paused") {
      this.resume();
    } else if (
      // No session of its own, even after one here ended in an error.
      !isActiveVoiceSession(status) &&
      (sessionElsewhere?.details?.phase === "recording" ||
        sessionElsewhere?.details?.phase === "paused")
    ) {
      // The pause key works on dictation another view owns, as its stop key does.
      void this.setSessionElsewherePaused(
        sessionElsewhere.sessionId,
        sessionElsewhere.details.phase === "recording"
      );
    } else {
      logDebug(`${LOG_PREFIX} togglePause() ignored`, { status });
    }
  }

  /**
   * Registers the composer that sends `panelId`'s prompt when the user says
   * "send it". The handler runs Enter's dictation path: stop, wait for the
   * correction, send.
   */
  onSpokenSend(
    panelId: string,
    projectId: string | undefined,
    handler: (options?: VoiceSendOptions) => void
  ): () => void {
    const key = spokenSendKey(panelId, projectId);
    this.spokenSendHandlers.set(key, handler);
    return () => {
      if (this.spokenSendHandlers.get(key) === handler) {
        this.spokenSendHandlers.delete(key);
      }
    };
  }

  /** Whether the session panel's Send has a composer to send from. */
  canSendActiveSession(): boolean {
    return "send" in this.activeSessionSend();
  }

  /**
   * The session panel's Send: the dictation stops and its composer sends the
   * draft as Enter would, without the person going there. Nothing happens
   * when no composer for it is mounted to send from. True means the composer
   * was asked, not that it sent: one that ignores the request says why in the
   * log itself.
   */
  sendActiveSession(asker: VoiceStopAndSendAsker = "stop_and_send_key"): boolean {
    this.initialize();
    return this.dispatchActiveSessionSend(asker) === null;
  }

  /** Why nothing was asked of a composer, or null once its composer has the request. */
  private dispatchActiveSessionSend(
    asker: VoiceStopAndSendAsker
  ): Extract<VoiceSendRefusal, "no_session" | "session_finishing" | "composer_unavailable"> | null {
    const active = this.activeSessionSend();
    if (!("send" in active)) return active.unsent;
    active.send({ spoken: false, asker });
    return null;
  }

  private activeSessionSend():
    | { send: (options?: VoiceSendOptions) => void }
    | { unsent: "no_session" | "session_finishing" | "composer_unavailable" } {
    const { activeTarget, status } = useVoiceRecordingStore.getState();
    if (!activeTarget || !isActiveVoiceSession(status)) return { unsent: "no_session" };
    if (status === "finishing") return { unsent: "session_finishing" };
    const send = this.spokenSendHandlers.get(
      spokenSendKey(activeTarget.panelId, activeTarget.projectId)
    );
    return send ? { send } : { unsent: "composer_unavailable" };
  }

  // A stop is the surest end of speech there is, so a send its drain lands goes
  // through Enter's wait like one heard mid-dictation (#14803), when the stop
  // is the user's own and nothing joined it or started since: Escape, a
  // retarget, Enter or a timeout must not get a send nobody asked for, and
  // joining the stop would cancel a newer start. A stopping session is never
  // stopped a second time.
  //
  // Main has already taken "send it" off the words, so a request that stops
  // here leaves a line in the log: the session heard it, `sessionId`, is the
  // one named, not a newer one in the panel (#15704).
  private handleSpokenSend(
    panelId: string,
    projectId: string | undefined,
    sessionId: string
  ): void {
    const refuse = (reason: VoiceSendRefusal) =>
      logVoiceSendRefused({ asker: "spoken_send", reason, panelId, sessionId });
    const voiceState = useVoiceRecordingStore.getState();
    if (voiceState.activeTarget?.panelId !== panelId) {
      refuse("target_changed");
      return;
    }
    const stopping = voiceState.status === "finishing";
    if (stopping) {
      if (!this.stopTakesSpokenSend) {
        refuse("stop_not_users");
        return;
      }
    } else if (voiceState.status !== "recording") {
      refuse("not_recording");
      return;
    }
    const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
    const handler = this.spokenSendHandlers.get(spokenSendKey(panelId, projectId));
    // A Canopy reply off screen, or on its way off as Canopy closes, has
    // nothing to send from: its words stay in its draft and the dictation
    // goes on (#14778).
    if (
      isCanopyReplyTarget(voiceState.activeTarget) &&
      (!handler || !useCanopyStore.getState().isOpen)
    ) {
      refuse("composer_unavailable");
      return;
    }
    if (handler && isSpokenSendable(draft)) {
      handler();
      return;
    }
    // A reply too short to send by voice stays in the draft (#14633). The stop
    // alone would pass for an ordinary one, so the composer says it wasn't
    // sent and how to send it, in place of the stop's own word (#14944).
    if (handler && draft.trim()) {
      refuse("draft_too_short");
      if (stopping) this.stopAnnounces = false;
      else void this.stop("Dictation stopped.", { reason: "send", announce: false });
      handler({ tooShort: true });
      return;
    }
    refuse(handler ? "draft_empty" : "composer_unavailable");
    if (!stopping) void this.stop("Dictation stopped.", { reason: "send" });
  }

  destroy(): void {
    this.cancelRevealWait?.();
    this.cancelRevealWait = null;
    // Late awaits and events find nothing to record into.
    for (const timeline of this.timelines.values()) timeline.dispose();
    this.timelines.clear();
    this.pendingPressAt = null;
    this.invalidatePendingStart();
    // Vite HMR disposes and re-evaluates this module; the old singleton's
    // timers must be cleared or they fire against the new singleton's state.
    this.clearPauseTimeout();
    this.clearIdleTimeout();
    this.clearCancelConfirm();
    this.clearScratchRefusal();
    this.clearElapsedTimer();
    this.sessionClockRunning = false;
    this.clearMicSilenceTimer();
    this.cancelScheduledPrefetch();
    // Release anyone waiting on a correction; none of them may land now, so
    // none of their underlines may stay either.
    const correctedPanels = new Set<string>();
    for (const correction of [...this.pendingCorrections]) {
      correctedPanels.add(correction.panelId);
      this.retireCorrection(correction);
    }
    for (const rewrite of [...this.pendingRewrites]) {
      correctedPanels.add(rewrite.panelId);
      this.retireRewrite(rewrite);
      rewrite.selection.release();
    }
    for (const panelId of correctedPanels) this.syncCorrectionRange(panelId);
    this.correctionStreams.clear();
    this.cleanups.clear();
    this.sendObservers.clear();
    this.resetChunking();
    this.baselineOwners.clear();
    this.unfollowLearningBaselines();
    this.spokenSendHandlers.clear();
    this.discardedSessionIds.clear();
    this.discardedSessionPanels.clear();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.retireWarmAudio();
    this.initialized = false;
  }

  // Idempotent and identity-scoped: a late flush of an old attempt never
  // clears a newer session's window.
  private flushOpeningAudio(openingAudio: OpeningAudio): void {
    if (this.openingAudio === openingAudio) this.openingAudio = null;
    if (openingAudio.logged) return;
    openingAudio.logged = true;
    if (openingAudio.chunks.length === 0) return;
    try {
      logInfo(`${LOG_PREFIX} Opening audio`, {
        startRequestId: openingAudio.startRequestId,
        ...summarizeOpeningChunks(openingAudio.chunks),
      });
    } catch {
      // Diagnostics must never abort a stop or drop a chunk.
    }
  }

  // The context outlives each start, so its listener is removed when the
  // capture releases it. Diagnostics must never abort start().
  private observeAudioContextState(
    audioContext: AudioContext,
    logStep: StartStepLogger
  ): (() => void) | null {
    try {
      if (typeof audioContext.addEventListener !== "function") return null;
      const listener = () => {
        logStep("audio_context_statechange", { state: audioContext.state });
      };
      audioContext.addEventListener("statechange", listener);
      return () => audioContext.removeEventListener?.("statechange", listener);
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not observe AudioContext state`, voiceErrorLogFields(err));
      return null;
    }
  }

  // A local track.stop() fires no "ended", so an "ended" here means the
  // device or OS pulled the track. Mute and unmute stay diagnostic: neither
  // proves the device is gone. Listeners are removed before the tracks are
  // stopped (stopStreamTracks).
  private observeTrackState(
    stream: MediaStream,
    logStep: StartStepLogger,
    onEnded: () => void
  ): void {
    const removers: Array<() => void> = [];
    try {
      const tracks = typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : [];
      tracks.forEach((track, trackIndex) => {
        if (typeof track.addEventListener !== "function") return;
        for (const event of ["mute", "unmute", "ended"] as const) {
          const listener = () => {
            try {
              logStep(`track_${event}`, {
                trackIndex,
                muted: track.muted,
                readyState: track.readyState,
              });
            } catch {
              // Diagnostics must never stop a lost mic from ending the session.
            }
            if (event === "ended") onEnded();
          };
          track.addEventListener(event, listener);
          removers.push(() => track.removeEventListener?.(event, listener));
        }
      });
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not observe microphone track state`, voiceErrorLogFields(err));
    }
    this.trackObserverDisposers.set(stream, () => {
      for (const remove of removers) remove();
    });
  }

  private stopStreamTracks(stream: MediaStream): void {
    const dispose = this.trackObserverDisposers.get(stream);
    if (dispose) {
      this.trackObserverDisposers.delete(stream);
      try {
        dispose();
      } catch {
        // Listener removal is best-effort; the tracks still have to stop.
      }
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  /**
   * The input device went away. A session on it ends the way a stop does —
   * audio already sent is drained and transcribed, live text is kept — and
   * the pane says why. An attempt not yet promoted is only marked: start()
   * checks before promoting it.
   */
  private handleTrackEnded(capture: CaptureAttempt): void {
    if (capture.lost) return;
    capture.lost = true;
    // A stop already owns the teardown, or this capture was superseded.
    if (this.sessionCapture !== capture || this.stopPromise || !this.initialized) return;
    const store = useVoiceRecordingStore.getState();
    logWarn(`${LOG_PREFIX} Microphone lost mid-session`, { status: store.status });
    // Published before the stop so it can't land on a session started after it.
    store.setMicNotice({
      kind: "lost",
      target: store.activeTarget ?? capture.target,
      deviceLabel: capture.deviceLabel,
    });
    this.playCue("dictation-error");
    void this.stop("Dictation stopped because the microphone was lost.", {
      preserveLiveText: true,
      silentCue: true,
      reason: "mic_lost",
    });
  }

  /**
   * Ask the worklet for the partial chunk it is still filling and wait for its
   * "flushed" marker. Port messages arrive in order, so once the marker lands
   * every chunk the worklet posted has been through onmessage and sent.
   */
  private async flushCapturedAudio(): Promise<void> {
    const node = this.workletNode;
    if (!node) return;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const flushed = new Promise<boolean>((resolve) => {
      this.pendingWorkletFlush = { node, resolve: () => resolve(true) };
      timeoutId = setTimeout(() => resolve(false), WORKLET_FLUSH_TIMEOUT_MS);
    });
    try {
      node.port.postMessage({ type: "flush" });
      if (!(await flushed)) {
        logWarn(`${LOG_PREFIX} Worklet did not confirm the final flush`, {
          timeoutMs: WORKLET_FLUSH_TIMEOUT_MS,
        });
      }
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not flush the worklet`, voiceErrorLogFields(err));
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (this.pendingWorkletFlush?.node === node) this.pendingWorkletFlush = null;
    }
  }

  private cleanupAudioCapture(): void {
    if (this.sessionCapture) this.cleanupCaptureResources(this.sessionCapture);
  }

  private isStartRequestStale(startRequestId: number): boolean {
    return !this.initialized || startRequestId !== this.startRequestId;
  }

  // Idempotent: a capture can be released by a cancel and again by the start
  // that built it.
  private cleanupCaptureResources(capture: CaptureAttempt): void {
    const workletNode = capture.workletNode;
    if (workletNode && this.workletNode === workletNode) {
      if (this.levelRaf !== null) {
        cancelAnimationFrame(this.levelRaf);
        this.levelRaf = null;
      }
      this.clearMicSilenceTimer();
    }

    // Tracks stop first: the OS microphone indicator must go out the moment
    // capture is released, whatever the graph teardown does after.
    if (capture.stream) {
      this.stopStreamTracks(capture.stream);
      if (this.stream === capture.stream) this.stream = null;
    }
    if (this.sessionCapture === capture) this.sessionCapture = null;

    try {
      capture.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    capture.source = null;
    if (workletNode) {
      workletNode.port.onmessage = null;
      try {
        // The context lives on, so the processor has to end itself.
        workletNode.port.postMessage({ type: "dispose" });
        workletNode.disconnect();
      } catch {
        // A processor that can't be reached is already gone.
      }
      if (this.workletNode === workletNode) this.workletNode = null;
    }

    capture.stopObservingContext?.();
    capture.stopObservingContext = null;
    this.releaseWarmAudio(capture);
  }

  private createWarmAudio(): WarmAudio {
    let context: AudioContext;
    try {
      context = new AudioContext({
        sampleRate: 24000,
        sinkId: { type: "none" },
      } as CaptureContextOptions);
    } catch (err) {
      logWarn(`${LOG_PREFIX} Silent sink rejected, capturing on the default output`, {
        ...voiceErrorLogFields(err),
      });
      context = new AudioContext({ sampleRate: 24000 });
    }
    // A runtime without sink selection ignores the option and opens the default.
    const sinkId = (context as AudioContext & { sinkId?: unknown }).sinkId;
    return {
      context,
      sink: typeof sinkId === "object" && sinkId !== null ? "none" : "default",
      keepAliveOscillator: null,
      keepAliveGain: null,
      workletReady: null,
      users: new Set(),
      transition: Promise.resolve(),
      idleTimer: null,
      retired: false,
    };
  }

  private acquireWarmAudio(logStep: StartStepLogger): WarmAudio {
    const warm = this.warmAudio;
    if (warm && !warm.retired && warm.context.state !== "closed") {
      this.clearWarmAudioExpiry(warm);
      logStep("audio_context_reuse", { state: warm.context.state, sink: warm.sink });
      return warm;
    }
    if (warm) this.retireWarmAudio(warm);
    logDebug(`${LOG_PREFIX} Creating AudioContext (24kHz)`);
    const created = this.createWarmAudio();
    this.warmAudio = created;
    logStep("audio_context_create", {
      state: created.context.state,
      sampleRate: created.context.sampleRate,
      sink: created.sink,
    });
    return created;
  }

  // Keep the AudioContext in "running" state while backgrounded. Chromium
  // suspends capture-only contexts (no output to destination) when the window
  // loses focus. Connecting a silent oscillator to the destination tricks the
  // engine into treating the context as audible so AudioWorkletNode keeps
  // firing. On the "none" sink it holds no output device open.
  private startKeepAlive(audio: WarmAudio): void {
    if (audio.keepAliveOscillator) return;
    const keepAliveGain = audio.keepAliveGain ?? audio.context.createGain();
    audio.keepAliveGain = keepAliveGain;
    keepAliveGain.gain.value = 0;
    const keepAliveOscillator = audio.context.createOscillator();
    keepAliveOscillator.connect(keepAliveGain);
    keepAliveGain.connect(audio.context.destination);
    keepAliveOscillator.start();
    audio.keepAliveOscillator = keepAliveOscillator;
  }

  // Loaded once per context. A failed load may leave the worklet scope half
  // set up, so the context is retired and the next start builds a fresh one.
  private loadWorklet(audio: WarmAudio): Promise<void> {
    if (!audio.workletReady) {
      logDebug(`${LOG_PREFIX} Loading pcm-processor worklet`);
      audio.workletReady = audio.context.audioWorklet.addModule("/pcm-processor.js");
      audio.workletReady.catch(() => this.retireWarmAudio(audio));
    }
    return audio.workletReady;
  }

  private queueWarmAudioTransition(audio: WarmAudio, step: () => Promise<void>): Promise<void> {
    const next = audio.transition.then(step);
    audio.transition = next.catch(() => {});
    return next;
  }

  private releaseWarmAudio(capture: CaptureAttempt): void {
    const audio = capture.audio;
    if (!audio.users.delete(capture) || audio.users.size > 0) return;
    if (audio.retired || this.warmAudio !== audio) {
      this.closeWarmAudio(audio);
      return;
    }
    // A suspended context renders nothing and, on a real sink, gives the
    // output device back. An interrupted one is suspended too, or it resumes
    // by itself when the interruption ends. Rechecked when it runs: a start
    // may have taken the context in the meantime.
    void this.queueWarmAudioTransition(audio, () =>
      audio.users.size === 0 && audio.context.state !== "closed"
        ? audio.context.suspend()
        : Promise.resolve()
    ).catch(() => {});
    this.clearWarmAudioExpiry(audio);
    audio.idleTimer = setTimeout(() => {
      audio.idleTimer = null;
      if (audio.users.size === 0) this.retireWarmAudio(audio);
    }, WARM_AUDIO_IDLE_MS);
  }

  private clearWarmAudioExpiry(audio: WarmAudio): void {
    if (audio.idleTimer === null) return;
    clearTimeout(audio.idleTimer);
    audio.idleTimer = null;
  }

  /** Closes the context now if nothing is capturing on it, else at its last release. */
  private retireWarmAudio(audio: WarmAudio | null = this.warmAudio): void {
    if (!audio) return;
    audio.retired = true;
    if (this.warmAudio === audio) this.warmAudio = null;
    this.clearWarmAudioExpiry(audio);
    if (audio.users.size === 0) this.closeWarmAudio(audio);
  }

  private closeWarmAudio(audio: WarmAudio): void {
    audio.retired = true;
    this.clearWarmAudioExpiry(audio);
    if (this.warmAudio === audio) this.warmAudio = null;
    if (audio.context.state === "closed") return;
    void audio.context.close().catch(() => {});
  }
}

export const voiceRecordingService = new VoiceRecordingService();

// In development, Vite HMR re-evaluates this module and creates a new
// singleton. Without cleanup, the old singleton's ipcRenderer.on listeners
// stay alive and forward every event twice, causing text duplication.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    voiceRecordingService.destroy();
  });
}
