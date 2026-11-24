import { useState } from "react";

/**
 * A function that keeps returning the previous result while `isEqual` says the
 * new one is equivalent, for use inside a store selector. `useShallow` only
 * compares one level, so a selector that builds nested structure (descriptors
 * holding id arrays) needs a comparison of its own to stay quiet while
 * unrelated fields change.
 *
 * It returns a function rather than wrapping the store hook so each call site
 * calls its store hook directly: a hook passed around as a value makes React
 * Compiler bail out of the whole component. The cache sits in a closure made
 * once in state, as `useShallow`'s sits in a ref.
 */
export function useStabilizer<T>(): (next: T, isEqual: (a: T, b: T) => boolean) => T {
  const [stabilize] = useState(() => {
    let held: { value: T } | undefined;
    return (next: T, isEqual: (a: T, b: T) => boolean): T => {
      if (held && isEqual(held.value, next)) return held.value;
      held = { value: next };
      return next;
    };
  });
  return stabilize;
}
