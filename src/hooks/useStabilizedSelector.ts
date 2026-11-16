import { useState } from "react";

class Stabilizer<T> {
  private previous: T | undefined;
  private has = false;

  stabilize(next: T, isEqual: (a: T, b: T) => boolean): T {
    if (this.has && isEqual(this.previous as T, next)) return this.previous as T;
    this.previous = next;
    this.has = true;
    return next;
  }
}

/**
 * A store selector that keeps returning the previous result while `isEqual`
 * says the new one is equivalent. `useShallow` only compares one level, so a
 * selector that builds nested structure (descriptors holding id arrays) needs
 * a comparison of its own to stay quiet while unrelated fields change.
 *
 * The cache lives on an object held in state, as `useShallow`'s does in a ref,
 * so the compiler sees an opaque call rather than a ref written during render.
 */
export function useStabilizedSelector<S, T>(
  useStore: <U>(selector: (state: S) => U) => U,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean
): T {
  const [stabilizer] = useState(() => new Stabilizer<T>());
  return useStore((state) => stabilizer.stabilize(selector(state), isEqual));
}
