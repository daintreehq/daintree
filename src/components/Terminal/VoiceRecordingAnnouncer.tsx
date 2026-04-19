import { useEffect, useRef } from "react";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

export function VoiceRecordingAnnouncer() {
  const announcement = useVoiceRecordingStore((state) => state.announcement);
  const ref = useRef<HTMLDivElement>(null);

  const pendingSetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!announcement?.text) {
      el.textContent = "";
      return;
    }

    el.textContent = "";
    pendingSetRef.current = setTimeout(() => {
      if (ref.current) {
        ref.current.textContent = announcement.text;
      }
    }, 0);

    return () => {
      if (pendingSetRef.current) {
        clearTimeout(pendingSetRef.current);
      }
    };
  }, [announcement]);

  return <div ref={ref} className="sr-only" role="status" aria-live="polite" aria-atomic="false" />;
}
