import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

export function AccessibilityAnnouncer() {
  const polite = useAnnouncerStore((s) => s.polite);
  const assertive = useAnnouncerStore((s) => s.assertive);

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {polite ? <span key={polite.id}>{polite.msg}</span> : null}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {assertive ? <span key={assertive.id}>{assertive.msg}</span> : null}
      </div>
    </>
  );
}
