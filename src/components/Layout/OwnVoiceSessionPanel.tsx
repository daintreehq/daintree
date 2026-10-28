import { useEffect, useState } from "react";
import { useHostList } from "@/components/Hosts/hostList";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { isCanopyReplyTarget } from "@/services/canopyReplyDictation";
import { sessionHostName } from "@/services/voiceSessionPlace";
import { currentHostId } from "@/hooks/useHostPlatform";
import { joinCompletedSegments } from "@/lib/voiceTranscriptSegments";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { transcriptionProviderName } from "@shared/config/voiceProviders";
import {
  VoiceSessionPanel,
  type VoiceSessionDetails,
  type VoiceSessionKind,
  type VoiceSessionPhase,
} from "./VoiceSessionPanel";

const PANEL_PHASES: ReadonlySet<string> = new Set<VoiceSessionPhase>([
  "arming",
  "connecting",
  "recording",
  "paused",
  "reconnecting",
  "finishing",
]);

const readLevel = () => useVoiceRecordingStore.getState().audioLevel;

function sessionKind(target: VoiceRecordingTarget): VoiceSessionKind {
  if (isCanopyReplyTarget(target)) return "canopy-reply";
  return target.rewrite ? "rewrite" : "dictation";
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * The session panel for the dictation this view owns, fed from its store and
 * service while it is open, so nothing here re-renders the toolbar. The clock
 * is re-read once a second and on every change of state.
 */
export function OwnVoiceSessionPanel({
  pauseShortcut,
  stopShortcut,
  onGoToTarget,
  onTogglePause,
  onStop,
}: {
  pauseShortcut?: string;
  stopShortcut?: string;
  onGoToTarget: () => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const status = useVoiceRecordingStore((state) => state.status);
  const target = useVoiceRecordingStore((state) => state.activeTarget);
  const lockedPanelId = useVoiceRecordingStore((state) => state.lockedTarget?.panelId ?? null);
  const micSignal = useVoiceRecordingStore((state) => state.micSignal);
  const micDeviceLabel = useVoiceRecordingStore((state) => state.micDeviceLabel);
  const micNotice = useVoiceRecordingStore((state) => state.micNotice);
  const correctionEnabled = useVoiceRecordingStore((state) => state.correctionEnabled);
  const buffer = useVoiceRecordingStore((state) =>
    target ? state.panelBuffers[target.panelId] : undefined
  );
  const panel = usePanelStore((state) =>
    target && !isCanopyReplyTarget(target) ? state.panelsById[target.panelId] : undefined
  );
  const { hosts } = useHostList();
  const [clock, setClock] = useState(() => voiceRecordingService.getSessionClock());

  useEffect(() => {
    const read = () => setClock(voiceRecordingService.getSessionClock());
    const interval = setInterval(read, 1000);
    const unsubscribe = useVoiceRecordingStore.subscribe((state, prev) => {
      if (state.status !== prev.status) read();
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  if (!target || !PANEL_PHASES.has(status)) return null;

  const isCanopyReply = isCanopyReplyTarget(target);
  const chrome = panel
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
    : null;
  const targetTitle =
    panel?.title?.trim() ||
    target.panelTitle?.trim() ||
    (isCanopyReply ? "Canopy reply" : "Terminal");
  const transcript = [joinCompletedSegments(buffer?.completedSegments ?? []), buffer?.liveText]
    .filter(Boolean)
    .join(" ");
  const notice =
    micNotice && micNotice.target.panelId === target.panelId
      ? { kind: micNotice.kind, bluetooth: micNotice.kind === "silent" && micNotice.bluetooth }
      : null;

  const details: VoiceSessionDetails = {
    phase: status as VoiceSessionPhase,
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

  return (
    <VoiceSessionPanel
      details={details}
      readLevel={readLevel}
      pauseShortcut={pauseShortcut}
      stopShortcut={stopShortcut}
      onGoToTarget={onGoToTarget}
      onTogglePause={onTogglePause}
      onStop={onStop}
    />
  );
}
