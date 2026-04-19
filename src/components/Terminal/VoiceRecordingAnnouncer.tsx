import { useEffect, useRef } from "react";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

export function VoiceRecordingAnnouncer() {
  const announcement = useVoiceRecordingStore((state) => state.announcement);
  const ref = useRef<HTMLDivElement>(null);

  const pendingSetRef = useRef<ReturnType<typeof queueMicrotask> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (pendingSetRef.current) {
      pendingSetRef.current();
      pendingSetRef.current = null;
    }

    if (!announcement?.text) {
      el.textContent = "";
      return;
    }

    el.textContent = "";
    pendingSetRef.current = queueMicrotask(() => {
      if (ref.current) {
        ref.current.textContent = announcement.text;
      }
    });
  }, [announcement]);

  return <div ref={ref} className="sr-only" role="status" aria-live="polite" aria-atomic="false" />;
}
