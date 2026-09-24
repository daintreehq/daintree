import { useLayoutEffect, useRef } from "react";

/**
 * Hands focus on when the subtree it wraps unmounts with focus inside.
 *
 * A focused control that unmounts strands the keyboard on the document. In the
 * worktree overview that happens whenever the bulk bar leaves (the selection
 * empties by any route) and whenever a row's sessions change shape (three
 * inline lines become an "N active" strip, or back). A layout-effect cleanup
 * runs before the subtree's DOM is detached, so it can still see whether focus
 * was inside; the hand-off itself waits for a microtask, until the subtree is
 * gone and its replacement, if any, is mounted.
 */
export function FocusHandoffGuard({
  onFocusLeaving,
  children,
}: {
  onFocusLeaving: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onFocusLeavingRef = useRef(onFocusLeaving);
  useLayoutEffect(() => {
    onFocusLeavingRef.current = onFocusLeaving;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.contains(document.activeElement)) {
        const handOff = onFocusLeavingRef.current;
        queueMicrotask(handOff);
      }
    };
  }, []);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
