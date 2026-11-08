/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorktreeDiskUsageMeasureRequest,
  WorktreeDiskUsageResult,
} from "@shared/types/ipc/worktreeDiskUsage";

const clientMock = vi.hoisted(() => ({
  measure: vi.fn<(request: WorktreeDiskUsageMeasureRequest) => Promise<WorktreeDiskUsageResult>>(),
  cancel: vi.fn<(request: { sessionId: string }) => Promise<void>>(),
}));

vi.mock("@/clients/worktreeDiskUsageClient", () => ({ worktreeDiskUsageClient: clientMock }));

import { useWorktreeDiskUsage } from "../useWorktreeDiskUsage";

interface Pending {
  request: WorktreeDiskUsageMeasureRequest;
  resolve: (result: WorktreeDiskUsageResult) => void;
  reject: (error: unknown) => void;
}

let pending: Pending[] = [];

function pendingAt(index: number): Pending {
  const entry = pending[index];
  if (!entry) throw new Error(`no pending request at ${index}`);
  return entry;
}

function sessionOf(call: number): string {
  const request = clientMock.measure.mock.calls[call]?.[0];
  if (!request) throw new Error(`no measure call ${call}`);
  return request.sessionId;
}

function answer(worktreeId: string, result: WorktreeDiskUsageResult): Promise<void> {
  const index = pending.findIndex((p) => p.request.worktreeId === worktreeId);
  const entry = pendingAt(index);
  pending.splice(index, 1);
  return act(async () => {
    entry.resolve(result);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const A = { id: "a", path: "/repo" };
const B = { id: "b", path: "/repo-b" };

describe("useWorktreeDiskUsage", () => {
  beforeEach(() => {
    pending = [];
    clientMock.measure.mockReset().mockImplementation(
      (request) =>
        new Promise((resolve, reject) => {
          pending.push({ request, resolve, reject });
        })
    );
    clientMock.cancel.mockReset().mockResolvedValue(undefined);
  });

  it("measures nothing while closed", async () => {
    const { result } = renderHook(() => useWorktreeDiskUsage(false, [A, B]));
    await settle();
    expect(clientMock.measure).not.toHaveBeenCalled();
    expect(result.current.get("a")).toEqual({ status: "pending" });
  });

  it("asks once per worktree in one session, and shows pending until each answers", async () => {
    const { result } = renderHook(() => useWorktreeDiskUsage(true, [A, B]));
    await settle();
    const requests = clientMock.measure.mock.calls.map(([r]) => r);
    expect(requests.map((r) => r.worktreeId)).toEqual(["a", "b"]);
    expect(new Set(requests.map((r) => r.sessionId)).size).toBe(1);
    expect(result.current.get("a")).toEqual({ status: "pending" });

    await answer("a", { status: "measured", bytes: 0 });
    expect(result.current.get("a")).toEqual({ status: "measured", bytes: 0 });
    expect(result.current.get("b")).toEqual({ status: "pending" });
  });

  it("reads a failed request as unknown, never zero", async () => {
    const { result } = renderHook(() => useWorktreeDiskUsage(true, [A]));
    await settle();
    await act(async () => {
      pendingAt(0).reject(new Error("IPC timeout"));
    });
    expect(result.current.get("a")).toEqual({ status: "unknown" });
  });

  it("doesn't re-measure on a status update, but measures a worktree that arrives", async () => {
    const { rerender } = renderHook(({ list }) => useWorktreeDiskUsage(true, list), {
      initialProps: { list: [A] },
    });
    await settle();
    rerender({ list: [{ ...A }] });
    await settle();
    expect(clientMock.measure).toHaveBeenCalledTimes(1);

    rerender({ list: [{ ...A }, B] });
    await settle();
    expect(clientMock.measure.mock.calls.map(([r]) => r.worktreeId)).toEqual(["a", "b"]);
  });

  it("measures again when a worktree's path changes, and a late answer for the old path can't overwrite the new", async () => {
    const { result, rerender } = renderHook(({ list }) => useWorktreeDiskUsage(true, list), {
      initialProps: { list: [A] },
    });
    await settle();
    rerender({ list: [{ id: "a", path: "/moved" }] });
    await settle();
    expect(clientMock.measure).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingAt(1).resolve({ status: "measured", bytes: 2 });
    });
    expect(result.current.get("a")).toEqual({ status: "measured", bytes: 2 });
    await act(async () => {
      pendingAt(0).resolve({ status: "measured", bytes: 1 });
    });
    expect(result.current.get("a")).toEqual({ status: "measured", bytes: 2 });
  });

  it("cancels the session on close and drops answers that land after it", async () => {
    const { result, rerender } = renderHook(({ open }) => useWorktreeDiskUsage(open, [A]), {
      initialProps: { open: true },
    });
    await settle();
    const sessionId = sessionOf(0);

    rerender({ open: false });
    await settle();
    expect(clientMock.cancel).toHaveBeenCalledWith({ sessionId });

    await answer("a", { status: "measured", bytes: 5 });
    expect(result.current.get("a")).toEqual({ status: "pending" });

    rerender({ open: true });
    await settle();
    expect(clientMock.measure.mock.calls[1]?.[0].worktreeId).toBe("a");
    expect(sessionOf(1)).not.toBe(sessionId);
  });

  it("cancels the session when the overview unmounts", async () => {
    const { unmount } = renderHook(() => useWorktreeDiskUsage(true, [A]));
    await settle();
    const sessionId = sessionOf(0);
    unmount();
    await settle();
    expect(clientMock.cancel).toHaveBeenCalledWith({ sessionId });
  });
});
