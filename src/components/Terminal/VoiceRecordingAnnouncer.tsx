import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

export function VoiceRecordingAnnouncer() {
  const announcement = useVoiceRecordingStore((state) => state.announcement);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
    </div>
  );
}
