import { useCallback, useRef, useState } from "react";

/** How one write settled, for the control that made it. */
export type ReconciledWriteResult =
  | { status: "saved" }
  | { status: "failed"; error: unknown }
  // An older write failed after a newer one was made; the newer one decides the control.
  | { status: "superseded"; error: unknown };

/**
 * One setting saved optimistically, whose writes can settle out of order. The control
 * shows the newest write still in play — one in flight, or the newest main confirmed —
 * so a failure falls back past every write that failed, never to whatever was on screen
 * when it was sent. Once every write settles, that is what main holds.
 */
export function useReconciledSetting<T>(fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const revisionRef = useRef(0);
  const confirmedRef = useRef({ revision: 0, value: fallback });
  const inFlightRef = useRef(new Map<number, T>());

  // A read replaces what main is known to hold, so no write made before it can overtake it.
  const hydrate = useCallback((loaded: T) => {
    confirmedRef.current = { revision: revisionRef.current, value: loaded };
    setValue(loaded);
  }, []);

  const showNewestInPlay = () => {
    let shown = confirmedRef.current;
    for (const [revision, pending] of inFlightRef.current) {
      if (revision > shown.revision) shown = { revision, value: pending };
    }
    setValue(shown.value);
  };

  const write = async (
    next: T,
    send: (value: T) => Promise<unknown>
  ): Promise<ReconciledWriteResult> => {
    const revision = ++revisionRef.current;
    inFlightRef.current.set(revision, next);
    setValue(next);
    try {
      await send(next);
    } catch (error) {
      inFlightRef.current.delete(revision);
      showNewestInPlay();
      return revision === revisionRef.current
        ? { status: "failed", error }
        : { status: "superseded", error };
    }
    inFlightRef.current.delete(revision);
    if (revision > confirmedRef.current.revision) confirmedRef.current = { revision, value: next };
    return { status: "saved" };
  };

  return { value, hydrate, write };
}
