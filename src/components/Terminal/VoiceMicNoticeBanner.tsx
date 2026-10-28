import { useState } from "react";
import { actionService } from "@/services/ActionService";
import { useVoiceRecordingStore, type VoiceMicNotice } from "@/store/voiceRecordingStore";
import { InlineStatusBanner, type BannerAction } from "./InlineStatusBanner";

export interface VoiceMicNoticeBannerProps {
  notice: VoiceMicNotice;
}

function openVoiceSettings(): void {
  void actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" });
}

// Loaded on use: the service is already in the app's first chunk, and a static
// import would tie every host of this banner to the whole dictation graph.
async function switchToMicFromNotice(notice: VoiceMicNotice): Promise<void> {
  const { voiceRecordingService } = await import("@/services/VoiceRecordingService");
  await voiceRecordingService.switchToMicFromNotice(notice);
}

/**
 * What the microphone did to this pane's dictation (#14606): it went away
 * mid-session, or it is delivering silence. Only a mic that isn't working
 * raises one; a working stand-in for the chosen mic is named in the
 * announcement and the session's details, not here. The device is named because "the microphone" is
 * ambiguous with AirPods, a dock and a laptop all connected.
 *
 * The service already speaks each of these through the dictation live region,
 * so the banner stays out of the accessibility announcements rather than
 * saying them twice.
 */
export function VoiceMicNoticeBanner({ notice }: VoiceMicNoticeBannerProps) {
  const [isSwitching, setIsSwitching] = useState(false);
  const dismiss = () => useVoiceRecordingStore.getState().dismissMicNotice(notice);
  const shared = {
    layout: "inline" as const,
    role: "status" as const,
    ariaLive: "off" as const,
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
