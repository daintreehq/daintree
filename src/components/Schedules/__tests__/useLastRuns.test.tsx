// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ScheduledRun } from "@shared/types/scheduledRuns";

const client = vi.hoisted(() => ({
  listLatestRuns: vi.fn(async (): Promise<ScheduledRun[]> => []),
  onRunsChanged: vi.fn(() => () => {}),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useLastRuns } from "../useLastRuns";

function deferred() {
  let resolve: (runs: ScheduledRun[]) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<ScheduledRun[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function runOf(id: string, scheduleId: string, createdAt: number): ScheduledRun {
  return {
    id,
    scheduleId,
    projectId: "p1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt,
    terminalId: null,
    terminalSpawnedAt: null,
    settlement: { state: "open" },
    process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
    pane: { state: "none" },
    resume: null,
  };
}

async function failedOnce() {
  client.listLatestRuns.mockRejectedValueOnce(new Error("The history couldn't be read"));
  const view = renderHook(() => useLastRuns("p1"));
  await waitFor(() => expect(view.result.current.lastRuns.status).toBe("error"));
  return view;
}

beforeEach(() => {
  client.listLatestRuns.mockReset();
  client.listLatestRuns.mockResolvedValue([]);
});

describe("useLastRuns — each schedule's last run (#17465)", () => {
  it("keeps the newest run per schedule when an older host sends the whole history", async () => {
    client.listLatestRuns.mockResolvedValueOnce([
      runOf("a-new", "a", 3_000),
      runOf("b", "b", 2_000),
      runOf("a-old", "a", 1_000),
    ]);
    const { result } = renderHook(() => useLastRuns("p1"));
    await waitFor(() => expect(result.current.lastRuns.status).toBe("ready"));

    const { byScheduleId } = result.current.lastRuns;
    expect([...byScheduleId].map(([scheduleId, run]) => [scheduleId, run.id])).toEqual([
      ["a", "a-new"],
      ["b", "b"],
    ]);
  });
});

describe("useLastRuns — Retry (#16907)", () => {
  it("marks a retry busy while it reads, and drops the mark once the read lands", async () => {
    const { result } = await failedOnce();
    const read = deferred();
    client.listLatestRuns.mockReturnValueOnce(read.promise);

    act(() => result.current.retryLastRuns());
    expect(result.current.lastRuns.retrying).toBe(true);
    expect(result.current.lastRuns.status).toBe("error");

    await act(async () => read.resolve([]));
    expect(result.current.lastRuns.status).toBe("ready");
    expect(result.current.lastRuns.retrying).not.toBe(true);
  });

  it("drops the mark when the retried read fails too, so Retry can be asked again", async () => {
    const { result } = await failedOnce();
    const read = deferred();
    client.listLatestRuns.mockReturnValueOnce(read.promise);

    act(() => result.current.retryLastRuns());
    expect(result.current.lastRuns.retrying).toBe(true);

    await act(async () => read.reject(new Error("Still unreadable")));
    expect(result.current.lastRuns.status).toBe("error");
    expect(result.current.lastRuns.retrying).toBe(false);
  });

  it("never marks a read that hadn't failed", async () => {
    const { result } = renderHook(() => useLastRuns("p1"));
    await waitFor(() => expect(result.current.lastRuns.status).toBe("ready"));
    client.listLatestRuns.mockReturnValueOnce(deferred().promise);
    act(() => result.current.retryLastRuns());
    expect(result.current.lastRuns.retrying).not.toBe(true);
  });
});
