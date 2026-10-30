import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { useVoiceRecordingStore, type VoiceMicNotice } from "@/store/voiceRecordingStore";
import { logError } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

export interface VoiceMicNoticeBannerProps {
  notice: VoiceMicNotice;
}

function openVoiceSettings(): void {
  void actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" });
}

async function switchToMicFromNotice(notice: VoiceMicNotice): Promise<void> {
  // Keep incidental hosts lazy without making the eager service itself a
  // dynamic entry: Rolldown gives that entry a circular initialization facade.
  const { switchVoiceMicFromNotice } = await import("@/services/switchVoiceMicFromNotice");
  await switchVoiceMicFromNotice(notice);
}

type SharedBannerProps = {
  layout: "inline";
  role: "status";
  ariaLive: "off";
  onClose: () => void;
  closeAriaLabel: string;
};

const RESTART_FAILURE_COPY = {
  // Main found no whole app on disk to come back up as: an install still copying, or undone.
  incomplete: "Couldn't restart: the updated app isn't fully installed yet",
  error: "Couldn't restart from here. Quit and reopen Daintree",
} as const;

/**
 * A silent mic in an app whose bundle was replaced while it ran (#14937):
 * macOS feeds the old process zeros, so no mic or setting helps and a restart
 * does. The restart keeps the session, but closes terminals and interrupts
 * agents mid-task, so every attempt is confirmed first.
 */
function AppReplacedMicNotice({
  deviceLabel,
  shared,
}: {
  deviceLabel: string | null;
  shared: SharedBannerProps;
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [failure, setFailure] = useState<keyof typeof RESTART_FAILURE_COPY | null>(null);
  const restartingRef = useRef(false);

  const restart = async () => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setIsRestarting(true);
    let outcome: "restarting" | keyof typeof RESTART_FAILURE_COPY;
    try {
      outcome = (await window.electron.voiceInput.restartReplacedApp())
        ? "restarting"
        : "incomplete";
    } catch (err) {
      logError(
        "Failed to restart Daintree after it was updated",
        undefined,
        voiceErrorLogFields(err)
      );
      outcome = "error";
    }
    // Daintree is on its way down; the banner goes with it.
    if (outcome === "restarting") return;
    restartingRef.current = false;
    setIsRestarting(false);
    setIsConfirmOpen(false);
    setFailure(outcome);
  };

  return (
    <>
      <InlineStatusBanner
        {...shared}
        severity="warning"
        title={`No audio from ${deviceLabel ?? "the microphone"}`}
        description={
          failure
            ? RESTART_FAILURE_COPY[failure]
            : "Daintree was updated while running and needs a restart"
        }
        action={{
          id: "restart-daintree",
          label: failure ? "Retry" : "Restart Daintree",
          variant: "primary",
          loading: isRestarting,
          onClick: () => setIsConfirmOpen(true),
        }}
      />
      <ConfirmDialog
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        title="Restart Daintree now?"
        description="Terminals close and agents resume after the restart. Work an agent is in the middle of is interrupted."
        confirmLabel="Restart Daintree"
        cancelLabel="Not now"
        variant="destructive"
        onConfirm={() => void restart()}
        isConfirmLoading={isRestarting}
      />
    </>
  );
}

/**
 * What the microphone did to this pane's dictation (#14606): it went away
 * mid-session, it is delivering silence, or the chosen mic wasn't available
 * and another is recording in its place (#15512). The device is named because
 * "the microphone" is ambiguous with AirPods, a dock and a laptop all
 * connected.
 *
 * The service already speaks each of these through the dictation live region,
 * so the banner stays out of the accessibility announcements rather than
 * saying them twice.
 */
export function VoiceMicNoticeBanner({ notice }: VoiceMicNoticeBannerProps) {
  const [isSwitching, setIsSwitching] = useState(false);
  const dismiss = () => useVoiceRecordingStore.getState().dismissMicNotice(notice);
  const shared: SharedBannerProps = {
    layout: "inline",
    role: "status",
    ariaLive: "off",
    onClose: dismiss,
    closeAriaLabel: "Dismiss microphone notice",
  };

  if (notice.kind === "lost") {
    return (
      <InlineStatusBanner
        {...shared}
        severity="warning"
        title="Microphone lost"
        description={`${notice.deviceLabel ?? "The microphone"} disconnected, so dictation stopped`}
      />
    );
  }

  if (notice.kind === "fallback") {
    return (
      <InlineStatusBanner
        {...shared}
        severity="info"
        title={`Using ${notice.deviceLabel ?? "another microphone"} instead of ${notice.chosenLabel ?? "the selected microphone"}`}
        description={`${notice.chosenLabel ?? "The selected microphone"} isn't available, so dictation is using the system default`}
        action={{
          id: "open-voice-settings",
          label: "Open Voice settings",
          onClick: openVoiceSettings,
        }}
      />
    );
  }

  if (notice.appReplaced) {
    return <AppReplacedMicNotice deviceLabel={notice.deviceLabel} shared={shared} />;
  }

  const { builtIn } = notice;
  const action: BannerAction = builtIn
    ? {
        id: "use-built-in-mic",
        label: `Use ${builtIn.label}`,
        title: "Also makes it your dictation microphone",
        variant: "primary",
        loading: isSwitching,
        onClick: () => {
          setIsSwitching(true);
          void switchToMicFromNotice(notice).finally(() => setIsSwitching(false));
        },
      }
    : { id: "open-voice-settings", label: "Open Voice settings", onClick: openVoiceSettings };

  return (
    <InlineStatusBanner
      {...shared}
      severity="warning"
      title={`No audio from ${notice.deviceLabel ?? "the microphone"}`}
      description={
        notice.bluetooth
          ? "Bluetooth mics can go quiet while they switch to call mode"
          : "Check that it's connected and not muted"
      }
      action={action}
    />
  );
}
