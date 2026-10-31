import { bench, describe } from "vitest";
import { MAX_CONSOLE_ROWS } from "@shared/config/devPreviewConsole";
import { reconcileCollapsedGroups } from "../consoleRowState";

// One flush of a steady collapsed logger (redux-logger with `collapsed: true`):
// a header and its child arrive, and the oldest pair leaves the full buffer.
function makeFlush(streamedGroups: number) {
  const firstLiveId = streamedGroups * 2 - MAX_CONSOLE_ROWS;
  const rows = Array.from({ length: MAX_CONSOLE_ROWS }, (_, i) => ({
    id: firstLiveId + i,
    cdpType: i % 2 === 0 ? "startGroupCollapsed" : "log",
  }));
  const arrived = [rows.at(-2)!.id];

  // Before pruning, every header ever logged stayed in the set.
  const accumulated = new Set<number>();
  for (let id = 0; id < firstLiveId + MAX_CONSOLE_ROWS - 2; id += 2) accumulated.add(id);

  // With pruning, only the headers that were live before this flush remain.
  const pruned = new Set<number>();
  for (let id = firstLiveId - 2; id < firstLiveId + MAX_CONSOLE_ROWS - 2; id += 2) pruned.add(id);

  return { rows, arrived, accumulated, pruned };
}

function mergeAccumulated(prev: Set<number>, arrived: readonly number[]): Set<number> {
  const merged = new Set(prev);
  for (const id of arrived) merged.add(id);
  return merged;
}

for (const streamedGroups of [5_000, 100_000, 144_000, 576_000]) {
  const { rows, arrived, accumulated, pruned } = makeFlush(streamedGroups);
  describe(`collapse-state update, ${streamedGroups.toLocaleString("en-US")} groups streamed`, () => {
    bench("unpruned: copy every id ever logged", () => {
      mergeAccumulated(accumulated, arrived);
    });
    bench("pruned: reconcile against live rows", () => {
      reconcileCollapsedGroups(pruned, rows, arrived);
    });
  });
}
