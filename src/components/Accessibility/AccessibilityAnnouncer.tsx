import { useEffect, useRef } from "react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export function AccessibilityAnnouncer() {
  const polite = useAnnouncerStore((s) => s.polite);
  const assertive = useAnnouncerStore((s) => s.assertive);

  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  const pendingClearRef = useRef<ReturnType<typeof queueMicrotask> | null>(null);
  const pendingSetRef = useRef<ReturnType<typeof queueMicrotask> | null>(null);

  useEffect(() => {
    const announce = (msg: string | null, ref: React.RefObject<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;

      if (pendingClearRef.current) {
        pendingClearRef.current();
        pendingClearRef.current = null;
      }
      if (pendingSetRef.current) {
        pendingSetRef.current();
        pendingSetRef.current = null;
      }

      if (!msg) {
        el.textContent = "";
        return;
      }

      el.textContent = "";
      pendingSetRef.current = queueMicrotask(() => {
        if (ref.current) {
          ref.current.textContent = msg;
        }
      });
    };

    announce(polite?.msg ?? null, politeRef);
    announce(assertive?.msg ?? null, assertiveRef);

    return () => {
      if (pendingClearRef.current) {
        pendingClearRef.current();
      }
      if (pendingSetRef.current) {
        pendingSetRef.current();
      }
    };
  }, [polite, assertive]);

  return (
    <>
      <div ref={politeRef} className="sr-only" aria-live="polite" aria-atomic="false" />
      <div ref={assertiveRef} className="sr-only" aria-live="assertive" aria-atomic="false" />
    </>
  );
}
