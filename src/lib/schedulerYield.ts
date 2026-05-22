// Yield control back to the browser between chunks of a long main-thread
// task so paint and input can run before the next chunk.
//
// Prefers `scheduler.yield()` (shipped in Chromium 129, stable in Electron 41 /
// Chromium 146): its continuation resumes ahead of newly-queued same-priority
// tasks, so a chunked pass is not starved by unrelated work queued mid-pass.
// Falls back to `scheduler.postTask` and finally a plain macrotask for
// environments without the Prioritized Task Scheduling API (older runtimes,
// jsdom under test). `scheduler` is declared globally in `src/types/scheduler.d.ts`.
export function yieldToScheduler(): Promise<void> {
  if (typeof scheduler !== "undefined" && scheduler !== null) {
    if (typeof scheduler.yield === "function") {
      return scheduler.yield();
    }
    if (typeof scheduler.postTask === "function") {
      return scheduler.postTask(() => {}, { priority: "user-visible" });
    }
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
