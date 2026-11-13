// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ScheduledRun } from "@shared/types/scheduledRuns";

const client = vi.hoisted(() => ({
  listRuns: vi.fn(async (): Promise<ScheduledRun[]> => []),
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

async function failedOnce() {
  client.listRuns.mockRejectedValueOnce(new Error("The history couldn't be read"));
  const view = renderHook(() => useLastRuns("p1"));
  await waitFor(() => expect(view.result.current.lastRuns.status).toBe("error"));
  return view;
}

beforeEach(() => {
  client.listRuns.mockReset();
  client.listRuns.mockResolvedValue([]);
});

describe("useLastRuns — Retry (#16907)", () => {
  it("marks a retry busy while it reads, and drops the mark once the read lands", async () => {
    const { result } = await failedOnce();
    const read = deferred();
    client.listRuns.mockReturnValueOnce(read.promise);

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
    client.listRuns.mockReturnValueOnce(read.promise);

    act(() => result.current.retryLastRuns());
    expect(result.current.lastRuns.retrying).toBe(true);

    await act(async () => read.reject(new Error("Still unreadable")));
    expect(result.current.lastRuns.status).toBe("error");
    expect(result.current.lastRuns.retrying).toBe(false);
  });

  it("never marks a read that hadn't failed", async () => {
    const { result } = renderHook(() => useLastRuns("p1"));
    await waitFor(() => expect(result.current.lastRuns.status).toBe("ready"));
    client.listRuns.mockReturnValueOnce(deferred().promise);
    act(() => result.current.retryLastRuns());
    expect(result.current.lastRuns.retrying).not.toBe(true);
  });
});
