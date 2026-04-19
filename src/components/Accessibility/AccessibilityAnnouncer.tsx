import { useEffect, useRef } from "react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export function AccessibilityAnnouncer() {
  const polite = useAnnouncerStore((s) => s.polite);
  const assertive = useAnnouncerStore((s) => s.assertive);

  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  const pendingSetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const announce = (msg: string | null, ref: React.RefObject<HTMLDivElement | null>) => {
      const el = ref.current;
      if (!el) return;

      if (!msg) {
        el.textContent = "";
        return;
      }

      el.textContent = "";
      pendingSetRef.current = setTimeout(() => {
        if (ref.current) {
          ref.current.textContent = msg;
        }
      }, 0);
    };

    announce(polite?.msg ?? null, politeRef);
    announce(assertive?.msg ?? null, assertiveRef);

    return () => {
      if (pendingSetRef.current) {
        clearTimeout(pendingSetRef.current);
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
