import type {
  useVoiceRecordingStore,
  VoiceMicNotice,
  VoiceMicSignal,
  VoiceRecordingTarget,
} from "@/store/voiceRecordingStore";
import type { VoiceSessionClock } from "@/services/VoiceRecordingService";
import { isCanopyReplyTarget } from "@/services/canopyReplyDictation";
import { sessionHostName } from "@/services/voiceSessionPlace";
import { currentHostId } from "@/hooks/useHostPlatform";
import { joinCompletedSegments } from "@/lib/voiceTranscriptSegments";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { transcriptionProviderName } from "@shared/config/voiceProviders";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { VoiceInputStatus } from "@shared/types";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type {
  VoiceSessionDetails,
  VoiceSessionKind,
  VoiceSessionPhase,
} from "@/components/Layout/VoiceSessionPanel";

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

type VoiceTranscriptBuffer = ReturnType<
  typeof useVoiceRecordingStore.getState
>["panelBuffers"][string];

function sessionKind(target: VoiceRecordingTarget): VoiceSessionKind {
  if (isCanopyReplyTarget(target)) return "canopy-reply";
  return target.rewrite ? "rewrite" : "dictation";
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export interface OwnVoiceSessionInput {
  status: VoiceInputStatus;
  target: VoiceRecordingTarget | null;
  lockedPanelId: string | null;
  micSignal: VoiceMicSignal;
  micDeviceLabel: string | null;
  micNotice: VoiceMicNotice | null;
  correctionEnabled: boolean;
  /** The target's transcript buffer. */
  buffer: VoiceTranscriptBuffer | undefined;
  /** The target's live panel; none for a Canopy reply. */
  panel: PanelInstance | undefined;
  hosts: readonly HostListEntry[];
  clock: VoiceSessionClock | null;
}

/**
 * The session panel's details for the dictation this view owns, from its
 * store and service: one place, so the view that shows them and what it
 * publishes to other views (#14921) say the same. Null when there is no
 * session for the panel to show.
 */
export function buildOwnVoiceSessionDetails({
  status,
  target,
  lockedPanelId,
  micSignal,
  micDeviceLabel,
  micNotice,
  correctionEnabled,
  buffer,
  panel,
  hosts,
  clock,
}: OwnVoiceSessionInput): VoiceSessionDetails | null {
  if (!target || !isPanelPhase(status)) return null;
  const isCanopyReply = isCanopyReplyTarget(target);
  const ptyPanel = panel && !isCanopyReply && isPtyPanel(panel) ? panel : null;
  const chrome = ptyPanel
    ? deriveTerminalChrome({
        kind: ptyPanel.kind,
        launchAgentId: ptyPanel.launchAgentId,
        runtimeIdentity: ptyPanel.runtimeIdentity,
        detectedAgentId: ptyPanel.detectedAgentId,
        detectedProcessId: ptyPanel.detectedProcessId,
        agentState: ptyPanel.agentState,
        runtimeStatus: ptyPanel.runtimeStatus,
        exitCode: ptyPanel.exitCode,
      })
    : null;
  const targetTitle =
    ptyPanel?.title?.trim() ||
    target.panelTitle?.trim() ||
    (isCanopyReply ? "Canopy reply" : "Terminal");
  const transcript = [joinCompletedSegments(buffer?.completedSegments ?? []), buffer?.liveText]
    .filter(Boolean)
    .join(" ");
  // A stand-in mic is named by micLabel already; only trouble is carried.
  const notice =
    micNotice && micNotice.kind !== "fallback" && micNotice.target.panelId === target.panelId
      ? {
          kind: micNotice.kind,
          bluetooth: micNotice.kind === "silent" && micNotice.bluetooth,
          ...(micNotice.kind === "silent" && micNotice.appReplaced
            ? { appReplaced: true as const }
            : {}),
        }
      : null;

  return {
    phase: status,
    kind: sessionKind(target),
    targetTitle,
    targetChrome: chrome,
    hostName: sessionHostName(target.otherHostId ?? currentHostId(), hosts),
    projectName: target.projectName ?? null,
    worktreeLabel: target.worktreeLabel ?? null,
    micLabel: micDeviceLabel,
    micSignal,
    micNotice: notice,
    providerName: clock?.provider ? transcriptionProviderName(clock.provider) : null,
    elapsedMs: clock?.elapsedMs ?? null,
    pausedMs: clock?.pausedMs ?? 0,
    autoStop: clock?.autoStop ?? null,
    correctionEnabled,
    locked: lockedPanelId === target.panelId,
    wordCount: countWords(transcript),
    transcript,
  };
}
