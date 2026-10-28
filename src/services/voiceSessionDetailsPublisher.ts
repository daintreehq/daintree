import {
  VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH,
  type VoiceInputStatus,
  type VoicePublishDetailsRequest,
  type VoiceSessionClockAnchor,
  type VoiceSessionKind,
  type VoiceSessionPhase,
  type VoiceSessionSnapshot,
} from "@shared/types";
import type { HostId } from "@shared/types/remoteHosts";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { VOICE_WORKSPACE_NAME_MAX_LENGTH } from "@shared/types/voice";
import { joinCompletedSegments } from "@/lib/voiceTranscriptSegments";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { isCanopyReplyTarget } from "@/services/canopyReplyDictation";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

type VoiceRecordingSnapshot = ReturnType<typeof useVoiceRecordingStore.getState>;

/** The owner's clock as the service reads it (`getSessionClock`). */
export interface VoiceOwnerClock {
  elapsedMs: number;
  pausedMs: number;
  autoStop: VoiceSessionClockAnchor["autoStop"];
}

/**
 * Coalesces the owner's reports: a burst of transcript words or a status change
 * that lands with its warnings goes to main once, and each report reaches every
 * other view, so nothing here may run per frame.
 */
export const VOICE_DETAILS_PUBLISH_MS = 200;

const PANEL_PHASES: ReadonlySet<VoiceInputStatus> = new Set<VoiceSessionPhase>([
  "arming",
  "connecting",
  "recording",
  "paused",
  "reconnecting",
  "finishing",
]);

function isPanelPhase(status: VoiceInputStatus): status is VoiceSessionPhase {
  return PANEL_PHASES.has(status);
}

function clip(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, VOICE_WORKSPACE_NAME_MAX_LENGTH);
}

function countWords(text: string): number {
  const words = text.trim();
  return words ? words.split(/\s+/).length : 0;
}

/**
 * What the owner's control panel shows of its live session, for main to pass
 * on to every other view (#14921). Null when this view has no session a panel
 * would show.
 */
export function buildVoiceSessionSnapshot(
  state: VoiceRecordingSnapshot,
  options: {
    panel: PanelInstance | undefined;
    clock: VoiceOwnerClock | null;
    hostId: HostId;
    now: number;
  }
): VoiceSessionSnapshot | null {
  const target = state.activeTarget;
  const phase = state.status;
  if (!target || !isPanelPhase(phase)) return null;
  const isCanopyReply = isCanopyReplyTarget(target);
  const panel = options.panel && !isCanopyReply && isPtyPanel(options.panel) ? options.panel : null;
  const kind: VoiceSessionKind = isCanopyReply
    ? "canopy-reply"
    : target.rewrite
      ? "rewrite"
      : "dictation";
  const buffer = state.panelBuffers[target.panelId];
  const transcript = [joinCompletedSegments(buffer?.completedSegments ?? []), buffer?.liveText]
    .filter(Boolean)
    .join(" ");
  const notice = state.micNotice;
  const { clock } = options;
  return {
    phase,
    kind,
    targetTitle:
      clip(panel?.title) ??
      clip(target.panelTitle) ??
      (isCanopyReply ? "Canopy reply" : "Terminal"),
    targetChrome: panel
      ? deriveTerminalChrome({
          kind: panel.kind,
          launchAgentId: panel.launchAgentId,
          runtimeIdentity: panel.runtimeIdentity,
          detectedAgentId: panel.detectedAgentId,
          detectedProcessId: panel.detectedProcessId,
          agentState: panel.agentState,
          runtimeStatus: panel.runtimeStatus,
          exitCode: panel.exitCode,
        })
      : null,
    targetHostId: target.otherHostId ?? options.hostId,
    projectName: clip(target.projectName),
    worktreeLabel: clip(target.worktreeLabel),
    micLabel: clip(state.micDeviceLabel),
    micSignal: state.micSignal,
    micNotice:
      notice && notice.target.panelId === target.panelId
        ? { kind: notice.kind, bluetooth: notice.kind === "silent" && notice.bluetooth }
        : null,
    stopWarning: phase === "paused" ? state.pauseStopWarning : state.idleStopWarning,
    correctionEnabled: state.correctionEnabled,
    locked: state.lockedTarget?.panelId === target.panelId,
    wordCount: countWords(transcript),
    transcript: transcript.slice(-VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH),
    clock: clock
      ? {
          at: options.now,
          elapsedMs: clock.elapsedMs,
          pausedMs: clock.pausedMs,
          paused: phase === "paused",
          autoStop: clock.autoStop,
        }
      : null,
  };
}

// Granularity of the clock's fixed points in a change key: finer than the
// panel shows, coarse enough that reading the same clock twice agrees.
const CLOCK_KEY_MS = 250;

// What makes a report worth sending. A running clock moves on its own, so its
// readings aren't a change; the points it runs from (when the session began,
// when the pause began, when it auto-stops) are.
function changeKey(snapshot: VoiceSessionSnapshot): string {
  const { clock, ...rest } = snapshot;
  const point = (ms: number) => Math.round(ms / CLOCK_KEY_MS);
  const fixed = clock
    ? [
        point(clock.at - clock.elapsedMs),
        clock.paused,
        point(clock.paused ? clock.at - clock.pausedMs : clock.pausedMs),
        clock.autoStop
          ? [clock.autoStop.reason, point(clock.at + clock.autoStop.remainingMs)]
          : null,
      ]
    : null;
  return JSON.stringify([rest, fixed]);
}

export interface VoiceDetailsSource {
  /** The session this view owns now, or null. */
  sessionId(): string | null;
  /** The owner's session clock at `now`, or null once it is stopping. */
  clock(now: number): VoiceOwnerClock | null;
  /** The host this view is on. */
  hostId(): HostId;
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
    const target = state.activeTarget;
    const now = Date.now();
    const details =
      sessionId && target
        ? buildVoiceSessionSnapshot(state, {
            panel: usePanelStore.getState().panelsById[target.panelId],
            clock: source.clock(now),
            hostId: source.hostId(),
            now,
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

  const unsubscribeVoice = useVoiceRecordingStore.subscribe(schedule);
  // The target pane's title and identity can change while nothing else does
  // (a quiet pause), so only its own changes count.
  let seenPanel: PanelInstance | undefined;
  const unsubscribePanels = usePanelStore.subscribe((state) => {
    const panelId = useVoiceRecordingStore.getState().activeTarget?.panelId;
    const panel = panelId ? state.panelsById[panelId] : undefined;
    if (panel === seenPanel) return;
    seenPanel = panel;
    schedule();
  });
  return () => {
    unsubscribeVoice();
    unsubscribePanels();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
