import { useEffect, useState } from "react";
import { useHostList } from "@/components/Hosts/hostList";
import { getElsewhereLevel } from "@/services/voiceElsewhereLevel";
import { sessionHostName } from "@/services/voiceSessionPlace";
import { transcriptionProviderName } from "@shared/config/voiceProviders";
import type { VoiceSessionElsewhere, VoiceSessionSnapshot } from "@shared/types";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { VoiceSessionPanel, type VoiceSessionDetails } from "./VoiceSessionPanel";

// The panel shows whole seconds.
const CLOCK_TICK_MS = 1000;

/**
 * The owner's snapshot as the panel shows it at `now`: the clock runs on from
 * the moment the owner read it, so a view needs no report per second.
 */
export function elsewherePanelDetails(
  session: VoiceSessionElsewhere,
  snapshot: VoiceSessionSnapshot,
  hosts: readonly HostListEntry[],
  now: number
): VoiceSessionDetails {
  const { clock } = snapshot;
  const since = clock ? Math.max(0, now - clock.at) : 0;
  return {
    phase: snapshot.phase,
    kind: snapshot.kind,
    targetTitle: snapshot.targetTitle,
    targetChrome: snapshot.targetChrome,
    hostName: sessionHostName(snapshot.targetHostId ?? session.hostId, hosts),
    projectName: snapshot.projectName ?? session.projectName,
    worktreeLabel: snapshot.worktreeLabel,
    micLabel: snapshot.micLabel,
    micSignal: snapshot.micSignal,
    micNotice: snapshot.micNotice,
    providerName: session.provider ? transcriptionProviderName(session.provider) : null,
    elapsedMs: clock ? clock.elapsedMs + since : null,
    pausedMs: clock ? clock.pausedMs + (clock.paused ? since : 0) : 0,
    autoStop: clock?.autoStop
      ? {
          reason: clock.autoStop.reason,
          remainingMs: Math.max(0, clock.autoStop.remainingMs - since),
        }
      : null,
    correctionEnabled: snapshot.correctionEnabled,
    locked: snapshot.locked,
    wordCount: snapshot.wordCount,
    transcript: snapshot.transcript,
  };
}

/**
 * The session panel for dictation another view owns (#14921), fed from what
 * the owner last reported through main. Its clock is re-read once a second
 * while the panel is open, as the owner's own panel does.
 */
export function ElsewhereVoiceSessionPanel({
  session,
  snapshot,
  pauseShortcut,
  stopShortcut,
  onGoToTarget,
  onTogglePause,
  onStop,
}: {
  session: VoiceSessionElsewhere;
  snapshot: VoiceSessionSnapshot;
  pauseShortcut?: string;
  stopShortcut?: string;
  onGoToTarget: () => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const { hosts } = useHostList();
  const [now, setNow] = useState(() => Date.now());
  const ticking = snapshot.clock !== null;

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, [ticking, snapshot]);

  const { sessionId } = session;
  return (
    <VoiceSessionPanel
      details={elsewherePanelDetails(session, snapshot, hosts, now)}
      readLevel={() => getElsewhereLevel(sessionId)}
      pauseShortcut={pauseShortcut}
      stopShortcut={stopShortcut}
      onGoToTarget={onGoToTarget}
      onTogglePause={onTogglePause}
      onStop={onStop}
    />
  );
}
