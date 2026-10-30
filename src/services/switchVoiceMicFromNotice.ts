import { voiceRecordingService } from "@/services/VoiceRecordingService";
import type { VoiceMicNotice } from "@/store/voiceRecordingStore";

export function switchVoiceMicFromNotice(notice: VoiceMicNotice): Promise<void> {
  return voiceRecordingService.switchToMicFromNotice(notice);
}
