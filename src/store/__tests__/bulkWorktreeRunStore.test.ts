import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BulkWorktreeRunSnapshot,
  BulkWorktreeRunsChanged,
} from "@shared/types/ipc/bulkWorktreeRuns";
import {
  _resetBulkWorktreeRunStoreForTest,
  useBulkWorktreeRunStore,
} from "../bulkWorktreeRunStore";

const run = (runId: string, phase: BulkWorktreeRunSnapshot["phase"]): BulkWorktreeRunSnapshot => ({
  runId,
  projectId: "proj-a",
  mode: "issue",
  phase,
  items: [],
  startedAt: 0,
  updatedAt: 0,
  controllable: true,
});

let push: ((change: BulkWorktreeRunsChanged) => void) | null = null;
let resolveList: (runs: BulkWorktreeRunSnapshot[]) => void = () => {};
const unsubscribe = vi.fn();

beforeEach(() => {
  push = null;
  unsubscribe.mockClear();
  (globalThis as unknown as { window: unknown }).window = {
    electron: {
      bulkWorktreeRuns: {
        list: () =>
          new Promise<BulkWorktreeRunSnapshot[]>((resolve) => {
            resolveList = resolve;
          }),
        onChanged: (callback: (change: BulkWorktreeRunsChanged) => void) => {
          push = callback;
          return unsubscribe;
        },
      },
    },
  };
});

afterEach(() => {
  _resetBulkWorktreeRunStoreForTest();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("bulkWorktreeRunStore", () => {
  it("subscribes only once something asks, then reads what main holds", async () => {
    expect(push).toBeNull();
    useBulkWorktreeRunStore.getState().init();
    useBulkWorktreeRunStore.getState().init();
    expect(push).not.toBeNull();

    resolveList([run("a", "running")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useBulkWorktreeRunStore.getState().runs.map((r) => r.runId)).toEqual(["a"]);

    push!({ runs: [run("a", "done"), run("b", "running")] });
    expect(useBulkWorktreeRunStore.getState().runs.map((r) => [r.runId, r.phase])).toEqual([
      ["a", "done"],
      ["b", "running"],
    ]);
  });

  it("keeps a push that lands before the first read answers", async () => {
    useBulkWorktreeRunStore.getState().init();
    push!({ runs: [run("a", "cancelled")] });

    resolveList([run("a", "running")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useBulkWorktreeRunStore.getState().runs[0]?.phase).toBe("cancelled");
  });

  it("stops listening on reset", () => {
    useBulkWorktreeRunStore.getState().init();
    _resetBulkWorktreeRunStoreForTest();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
