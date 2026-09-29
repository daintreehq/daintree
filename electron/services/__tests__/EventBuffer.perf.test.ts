import { describe, it } from "vitest";
import { events } from "../events.js";
import type { WorktreeState } from "../../../shared/types/index.js";

const gc = (globalThis as { gc?: () => void }).gc;
import { EventBuffer } from "../EventBuffer.js";

// Opt-in micro-benchmark: EVENTBUFFER_BENCH=1 npx vitest run electron/services/__tests__/EventBuffer.perf.test.ts
const run = process.env.EVENTBUFFER_BENCH ? describe : describe.skip;

function snapshot(files: number, i: number) {
  return {
    worktreeId: "/tmp/wt-1",
    path: "/tmp/wt-1",
    name: "wt-1",
    branch: "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    timestamp: Date.now(),
    counter: i,
    worktreeChanges: {
      worktreeId: "/tmp/wt-1",
      rootPath: "/tmp/wt-1",
      changedFileCount: files,
      changes: Array.from({ length: files }, (_, k) => ({
        path: `src/components/some/deep/path/file-${k}.ts`,
        status: "modified",
        insertions: k,
        deletions: 1,
      })),
    },
  };
}

run("EventBuffer push cost", () => {
  for (const files of [5, 50, 200]) {
    it(`sys:worktree:update x ${files} files`, () => {
      const N = 4000;
      const windows = 3;
      const bufs = Array.from({ length: windows }, () => {
        const b = new EventBuffer(1000);
        b.start();
        return b;
      });
      const payloads = Array.from({ length: N }, (_, i) => snapshot(files, i));
      gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      for (const p of payloads) events.emit("sys:worktree:update", p as unknown as WorktreeState);
      const ms = performance.now() - t0;
      gc?.();
      const heapMB = (process.memoryUsage().heapUsed - heap0) / 1048576;
      process.stderr.write(
        `BENCH files=${files} windows=${windows} events=${N} us/event=${((ms * 1000) / N).toFixed(2)} totalMs=${ms.toFixed(1)} heapDeltaMB=${heapMB.toFixed(1)}\n`
      );
      bufs.forEach((b) => b.stop());
    });
  }
});
