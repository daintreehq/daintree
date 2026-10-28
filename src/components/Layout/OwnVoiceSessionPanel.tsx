import { useEffect, useState } from "react";
import { useHostList } from "@/components/Hosts/hostList";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { buildOwnVoiceSessionDetails } from "@/services/ownVoiceSessionDetails";
import { VoiceSessionPanel } from "./VoiceSessionPanel";

const CLOCK_READ_INTERVAL_MS = 1000;

const readLevel = () => useVoiceRecordingStore.getState().audioLevel;

/**
 * The session panel for the dictation this view owns, fed from its store and
 * service while it is open, so nothing here re-renders the toolbar. The clock
 * is re-read once a second and on every change of state.
 */
export function OwnVoiceSessionPanel({
  pauseShortcut,
  stopShortcut,
  sendShortcut,
  onGoToTarget,
  onTogglePause,
  onStop,
  onSend,
}: {
  pauseShortcut?: string;
  stopShortcut?: string;
  sendShortcut?: string;
  onGoToTarget: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  onSend: () => void;
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
  const panel = usePanelStore((state) => (target ? state.panelsById[target.panelId] : undefined));
  const { hosts } = useHostList();
  const [clock, setClock] = useState(() => voiceRecordingService.getSessionClock());

  useEffect(() => {
    const read = () => setClock(voiceRecordingService.getSessionClock());
    const interval = setInterval(read, CLOCK_READ_INTERVAL_MS);
    const unsubscribe = useVoiceRecordingStore.subscribe((state, prev) => {
      if (state.status !== prev.status) read();
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  const details = buildOwnVoiceSessionDetails({
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
  });
  if (!details) return null;

  return (
    <VoiceSessionPanel
      details={details}
      readLevel={readLevel}
      pauseShortcut={pauseShortcut}
      stopShortcut={stopShortcut}
      onGoToTarget={onGoToTarget}
      onTogglePause={onTogglePause}
      onStop={onStop}
      sendShortcut={sendShortcut}
      onSend={onSend}
      // Read with the rest each render, which the clock drives once a second.
      canSend={voiceRecordingService.canSendActiveSession()}
    />
  );
}
