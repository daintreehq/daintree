import { lazyWhenLoaded } from "@/lib/lazyWithPreload";

/**
 * The find bar, loaded the first time a terminal opens search. Every pane and
 * Canopy terminal can open one, so a static import put it in all of their
 * chunks. It focuses its own field on mount, so it takes the keyboard whenever
 * its chunk lands.
 */
export const LazyTerminalSearchBar = lazyWhenLoaded(
  () => import("./TerminalSearchBar"),
  (m) => m.TerminalSearchBar
);
