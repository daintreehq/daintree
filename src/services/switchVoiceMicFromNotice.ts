import { loadVoiceRecordingService } from "@/services/voiceRecordingRuntime";
import type { VoiceMicNotice } from "@/store/voiceRecordingStore";

export async function switchVoiceMicFromNotice(notice: VoiceMicNotice): Promise<void> {
  return (await loadVoiceRecordingService()).switchToMicFromNotice(notice);
}
