/**
 * The clock as of this render, read where React Compiler counts it as a
 * dependency.
 *
 * A bare `Date.now()` in a compiled component or hook is not one: the compiler
 * moves it into whichever memo block consumes it and caches it with that
 * block, so a check that only ages (a stalled reconnect, an activity window)
 * keeps its first answer. A hook's return value always is one, so the sidebar's
 * per-render checks re-evaluate on every render, as they did before it was
 * compiled. A reading that should hold steady between renders and flip on a
 * schedule belongs in `useWallClock` instead.
 */
export function useRenderTime(): number {
  return Date.now();
}
