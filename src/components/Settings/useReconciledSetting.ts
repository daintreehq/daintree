import { useCallback, useRef, useState } from "react";

/** How one write settled, for the control that made it. */
export type ReconciledWriteResult =
  | { status: "saved" }
  | { status: "failed"; error: unknown }
  // An older write failed after a newer one was made; the newer one decides the control.
  | { status: "superseded"; error: unknown };

/**
 * One setting saved optimistically, whose writes can settle out of order. A failure
 * rolls the control back only while it is still the newest write, and then to the
 * newest value main confirmed — never to whatever was on screen when it was sent.
 */
export function useReconciledSetting<T>(fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const revisionRef = useRef(0);
  const confirmedRef = useRef({ revision: 0, value: fallback });
  const failedRevisionRef = useRef<number | null>(null);

  // A read replaces what main is known to hold, so no write made before it can overtake it.
  const hydrate = useCallback((loaded: T) => {
    confirmedRef.current = { revision: revisionRef.current, value: loaded };
    setValue(loaded);
  }, []);

  const write = async (
    next: T,
    send: (value: T) => Promise<unknown>
  ): Promise<ReconciledWriteResult> => {
    const revision = ++revisionRef.current;
    setValue(next);
    try {
      await send(next);
    } catch (error) {
      if (revision !== revisionRef.current) return { status: "superseded", error };
      failedRevisionRef.current = revision;
      setValue(confirmedRef.current.value);
      return { status: "failed", error };
    }
    if (revision > confirmedRef.current.revision) {
      confirmedRef.current = { revision, value: next };
      // An older write landed after the newest had already failed and rolled the
      // control back: main now holds this value, so the control follows it.
      if (failedRevisionRef.current === revisionRef.current) setValue(next);
    }
    return { status: "saved" };
  };

  return { value, hydrate, write };
}
