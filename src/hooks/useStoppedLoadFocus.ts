import { useCallback, useRef } from "react";

/**
 * A web pane's loading overlay unmounts its own Cancel as the load stops, which
 * drops focus on `document.body` and strands a keyboard user. This hands focus
 * to the stopped state's first action instead, ringed only when the Cancel was:
 * a pointer press moves focus without painting a ring nobody asked for.
 *
 * Wrap the overlay's `onCancel` with `wrapCancel`, and give `actionRef` to the
 * button the stopped state leads with. The toolbar's Stop needs neither: its
 * button stays where it is.
 */
export function useStoppedLoadFocus() {
  const pendingRef = useRef<{ ringed: boolean } | null>(null);

  const wrapCancel = useCallback(
    (onCancel: () => void) => () => {
      const active = document.activeElement;
      pendingRef.current =
        active instanceof HTMLElement && active !== document.body
          ? { ringed: active.matches(":focus-visible") }
          : null;
      onCancel();
      // Only the commit this press causes may take it: a stopped state that
      // mounts later, after some other error, did not come from this Cancel.
      setTimeout(() => {
        pendingRef.current = null;
      }, 0);
    },
    []
  );

  const actionRef = useCallback((element: HTMLButtonElement | null) => {
    const pending = pendingRef.current;
    if (!element || !pending) return;
    pendingRef.current = null;
    // Something else already took focus in the same commit; leave it there.
    if (document.activeElement && document.activeElement !== document.body) return;
    element.focus({ preventScroll: true, focusVisible: pending.ringed });
  }, []);

  return { wrapCancel, actionRef };
}
