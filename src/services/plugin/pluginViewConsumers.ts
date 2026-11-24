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

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const mounts = new Map<number, string>();
let nextToken = 1;
let flushScheduled = false;
/** The snapshot main holds; `null` when that is unknown, so the next flush sends. */
let reported: string | null = "";
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_MIN_MS;

/**
 * A lost report would leave main with the wrong mounts until the next one,
 * which may never come while the view sits open: retry until one lands.
 */
function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    schedule();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
}

function flush(): void {
  flushScheduled = false;
  const viewIds = [...mounts.values()].sort();
  const key = viewIds.join("\n");
  if (key === reported) return;
  const report =
    typeof window !== "undefined" ? window.electron?.plugin?.reportViewConsumers : undefined;
  if (!report) return;
  reported = key;
  void report(viewIds).then(
    () => {
      if (reported === key) retryDelayMs = RETRY_MIN_MS;
    },
    (error: unknown) => {
      if (reported !== key) return;
      reported = null;
      scheduleRetry();
      logWarn("[PluginViewConsumers] Failed to report mounted plugin views", { error });
    }
  );
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

/**
 * Send the current mounts again, for a main that has lost what this renderer
 * told it: a remote host that started a fresh session for this view.
 */
export function replayPluginViewConsumers(): void {
  if (mounts.size === 0 && reported === "") return;
  reported = null;
  schedule();
}

/** Test seam — forget every mount and what was last reported, without sending. */
export function resetPluginViewConsumersForTests(): void {
  mounts.clear();
  nextToken = 1;
  flushScheduled = false;
  reported = "";
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelayMs = RETRY_MIN_MS;
}
