import {
  isActiveVoiceSession,
  type VoicePublishDetailsRequest,
  type VoiceSessionDetails,
  type VoiceSessionKind,
} from "@shared/types";
import { VOICE_WORKSPACE_NAME_MAX_LENGTH } from "@shared/types/voice";
import { VOICE_PARAGRAPH_BREAK } from "@/lib/voiceTranscriptSegments";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

type VoiceRecordingSnapshot = ReturnType<typeof useVoiceRecordingStore.getState>;

/**
 * Coalesces the owner's reports: a burst of transcript words or a status change
 * that lands with its warnings goes to main once, and each report reaches every
 * other view, so nothing here may run per frame.
 */
export const VOICE_DETAILS_PUBLISH_MS = 200;

function clip(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  return trimmed.length > VOICE_WORKSPACE_NAME_MAX_LENGTH
    ? trimmed.slice(0, VOICE_WORKSPACE_NAME_MAX_LENGTH)
    : trimmed;
}

function countWords(text: string): number {
  const words = text.trim();
  return words ? words.split(/\s+/).length : 0;
}

/**
 * What the owner shows of its live session, for main to pass on to every other
 * view (#14921). Null when this view has no session the others should see.
 */
export function buildVoiceSessionDetails(
  state: VoiceRecordingSnapshot,
  options: { elapsed: VoiceSessionDetails["elapsed"]; agentId: string | null }
): VoiceSessionDetails | null {
  const target = state.activeTarget;
  if (!target || !isActiveVoiceSession(state.status)) return null;
  const buffer = state.panelBuffers[target.panelId];
  const segments = buffer?.completedSegments ?? [];
  const wordCount =
    segments.reduce(
      (sum, segment) => (segment === VOICE_PARAGRAPH_BREAK ? sum : sum + countWords(segment)),
      0
    ) + countWords(buffer?.liveText ?? "");
  const kind: VoiceSessionKind = target.rewrite
    ? "rewrite"
    : target.surface === "canopy-reply"
      ? "canopy-reply"
      : "dictation";
  const notice = state.micNotice;
  const micNotice =
    notice && notice.kind !== "lost" && notice.target.panelId === target.panelId
      ? { kind: notice.kind, bluetooth: notice.kind === "silent" && notice.bluetooth }
      : null;
  return {
    status: state.status,
    kind,
    panelTitle: clip(target.panelTitle),
    worktreeLabel: clip(target.worktreeLabel),
    agentId: options.agentId,
    locked: state.lockedTarget?.panelId === target.panelId,
    correctionEnabled: state.correctionEnabled,
    micDeviceLabel: clip(state.micDeviceLabel),
    micSignal: state.micSignal,
    micNotice,
    pauseStopWarning: state.pauseStopWarning,
    idleStopWarning: state.idleStopWarning,
    wordCount,
    elapsed: options.elapsed,
  };
}

// What makes a report worth sending: a running clock moves on its own, so
// neither its count nor its anchor is a change; a stopped one's count is.
function changeKey(details: VoiceSessionDetails): string {
  const { elapsed, ...rest } = details;
  return JSON.stringify([rest, elapsed.ticking, elapsed.ticking ? null : elapsed.seconds]);
}

function targetAgentId(panelId: string): string | null {
  const panel = usePanelStore.getState().panelsById[panelId];
  return panel?.detectedAgentId ?? panel?.launchAgentId ?? null;
}

export interface VoiceDetailsSource {
  /** The session this view owns now, or null. */
  sessionId(): string | null;
  /** The owner's elapsed clock, anchored to the moment its count last went up. */
  elapsed(): VoiceSessionDetails["elapsed"];
}

/**
 * Reports the owner's session to main whenever what it shows changes, at most
 * once per window however busy the session is. `publish` resolves false when
 * main didn't take the report (its start hadn't reached main yet), so the next
 * change sends it again. Returns the cleanup, which drops a report still
 * waiting.
 */
export function startVoiceDetailsPublisher(
  source: VoiceDetailsSource,
  publish: (request: VoicePublishDetailsRequest) => Promise<boolean>
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSessionId: string | null = null;
  let lastKey: string | null = null;

  const flush = () => {
    timer = null;
    const sessionId = source.sessionId();
    const state = useVoiceRecordingStore.getState();
    const details =
      sessionId && state.activeTarget
        ? buildVoiceSessionDetails(state, {
            elapsed: source.elapsed(),
            agentId: targetAgentId(state.activeTarget.panelId),
          })
        : null;
    // Main forgets a session's report when the session ends.
    if (!sessionId || !details) {
      lastSessionId = null;
      lastKey = null;
      return;
    }
    const key = changeKey(details);
    if (sessionId === lastSessionId && key === lastKey) return;
    lastSessionId = sessionId;
    lastKey = key;
    void publish({ sessionId, details }).then((accepted) => {
      if (!accepted && lastSessionId === sessionId && lastKey === key) lastKey = null;
    });
  };

  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, VOICE_DETAILS_PUBLISH_MS);
  };

  const unsubscribe = useVoiceRecordingStore.subscribe(schedule);
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
