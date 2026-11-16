import { lazyWithPreload } from "@/lib/lazyWithPreload";

// Every pane has a header and a context menu, so the picker loads on demand:
// both preload it as their menu opens, ahead of the pick.
export const LazyMoveToWorktreePicker = lazyWithPreload(
  () => import("./MoveToWorktreePicker"),
  (mod) => mod.MoveToWorktreePicker
);
