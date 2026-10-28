import {
  VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH,
  type VoicePublishDetailsRequest,
  type VoiceSessionSnapshot,
} from "@shared/types";
import type { HostId } from "@shared/types/remoteHosts";
import type { PanelInstance } from "@shared/types/panel";
import { VOICE_WORKSPACE_NAME_MAX_LENGTH } from "@shared/types/voice";
import type { VoiceSessionClock } from "@/services/VoiceRecordingService";
import { buildOwnVoiceSessionDetails } from "@/services/ownVoiceSessionDetails";
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
  return trimmed.slice(0, VOICE_WORKSPACE_NAME_MAX_LENGTH);
}

/**
 * What the owner's control panel shows of its live session, for main to pass
 * on to every other view (#14921): the owner's own panel details, with the
 * clock as an anchor a view runs on and the host as an id each view names for
 * itself. Null when this view has no session a panel would show.
 */
export function buildVoiceSessionSnapshot(
  state: VoiceRecordingSnapshot,
  options: {
    panel: PanelInstance | undefined;
    clock: VoiceSessionClock | null;
    hostId: HostId;
    now: number;
  }
): VoiceSessionSnapshot | null {
  const target = state.activeTarget;
  if (!target) return null;
  const details = buildOwnVoiceSessionDetails({
    status: state.status,
    target,
    lockedPanelId: state.lockedTarget?.panelId ?? null,
    micSignal: state.micSignal,
    micDeviceLabel: state.micDeviceLabel,
    micNotice: state.micNotice,
    correctionEnabled: state.correctionEnabled,
    buffer: state.panelBuffers[target.panelId],
    panel: options.panel,
    // The host goes as an id, so the owner's name for it doesn't matter.
    hosts: [],
    clock: options.clock,
  });
  if (!details) return null;
  const { phase, elapsedMs } = details;
  return {
    phase,
    kind: details.kind,
    targetTitle: clip(details.targetTitle) ?? details.targetTitle,
    targetChrome: details.targetChrome,
    targetHostId: target.otherHostId ?? options.hostId,
    projectName: clip(details.projectName),
    worktreeLabel: clip(details.worktreeLabel),
    micLabel: clip(details.micLabel),
    micSignal: details.micSignal,
    micNotice: details.micNotice,
    stopWarning: phase === "paused" ? state.pauseStopWarning : state.idleStopWarning,
    correctionEnabled: details.correctionEnabled,
    locked: details.locked,
    wordCount: details.wordCount,
    transcript: details.transcript.slice(-VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH),
    clock:
      elapsedMs === null
        ? null
        : {
            at: options.now,
            elapsedMs,
            pausedMs: details.pausedMs,
            paused: phase === "paused",
            autoStop: details.autoStop,
          },
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
  clock(now: number): VoiceSessionClock | null;
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
