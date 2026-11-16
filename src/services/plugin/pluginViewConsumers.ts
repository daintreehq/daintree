import { logWarn } from "@/utils/logger";

/**
 * The plugin views this renderer has mounted outside the panel grid, reported
 * to main so it never retires the worker under one that is on screen (#17068).
 * Grid panels reach main through the panel lifecycle stream; these have no
 * panel record, so this is the only account of them.
 *
 * Each mount holds its own token, so two homes showing the same view, or a
 * StrictMode replay whose cleanup runs after the next mount, release only what
 * they retained. Changes in one tick go out as one full snapshot. A renderer
 * that never mounts a plugin view never sends anything.
 */

const mounts = new Map<number, string>();
let nextToken = 1;
let flushScheduled = false;
/** The snapshot main holds; `null` once a send failed, so the next change resends. */
let reported: string | null = "";

function flush(): void {
  flushScheduled = false;
  const viewIds = [...mounts.values()].sort();
  const key = viewIds.join("\n");
  if (key === reported) return;
  const report =
    typeof window !== "undefined" ? window.electron?.plugin?.reportViewConsumers : undefined;
  if (!report) return;
  reported = key;
  void report(viewIds).catch((error: unknown) => {
    if (reported === key) reported = null;
    logWarn("[PluginViewConsumers] Failed to report mounted plugin views", { error });
  });
}

function schedule(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/**
 * Record that a plugin view is mounted outside the grid: `viewId` is its hosted
 * view id, or the panel kind a surface draws. Returns the release.
 */
export function retainPluginViewConsumer(viewId: string): () => void {
  const token = nextToken++;
  mounts.set(token, viewId);
  schedule();
  return () => {
    if (mounts.delete(token)) schedule();
  };
}

/** Test seam — forget every mount and what was last reported, without sending. */
export function resetPluginViewConsumersForTests(): void {
  mounts.clear();
  nextToken = 1;
  flushScheduled = false;
  reported = "";
}
