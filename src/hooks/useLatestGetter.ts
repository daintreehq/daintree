import { useCallback, useEffect, useRef } from "react";

/**
 * A stable getter for the value of the latest render, for code that outlives a
 * render and must not capture it: an async handler installed once into an
 * editor, say. The ref lives in here so the caller never touches one during
 * render, which React Compiler would flag.
 */
export function useLatestGetter<T>(value: T): () => T {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return useCallback(() => ref.current, []);
}
