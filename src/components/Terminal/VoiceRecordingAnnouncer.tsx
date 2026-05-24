import { useEffect, useRef } from "react";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

export function VoiceRecordingAnnouncer() {
  const announcement = useVoiceRecordingStore((state) => state.announcement);
  const ref = useRef<HTMLDivElement>(null);

  const pendingSetRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!announcement?.text) {
      el.textContent = "";
      return;
    }

    // Clear synchronously, then set the new text on the next animation frame.
    // A requestAnimationFrame callback runs before paint, which guarantees the
    // cleared state commits to the accessibility tree as its own frame before
    // the new text lands — so the screen reader sees a genuine change. A
    // setTimeout(0) fires in a fresh task that Chromium 146 can coalesce into
    // the same frame, dropping the intermediate empty state and the announcement.
    el.textContent = "";
    const text = announcement.text;
    pendingSetRef.current = requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.textContent = text;
      }
    });

    return () => {
      if (pendingSetRef.current !== null) {
        cancelAnimationFrame(pendingSetRef.current);
      }
    };
  }, [announcement]);

  return <div ref={ref} className="sr-only" role="status" aria-live="polite" aria-atomic="false" />;
}
