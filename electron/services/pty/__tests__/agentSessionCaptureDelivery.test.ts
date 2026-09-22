import { afterEach, describe, expect, it, vi } from "vitest";

const { getGitBranch } = vi.hoisted(() => ({
  getGitBranch: vi.fn<(cwd: string) => Promise<string | null>>(),
}));
vi.mock("../../../utils/gitUtils.js", () => ({ getGitBranch }));

import {
  finishAgentSessionCaptures,
  resetAgentSessionCaptureDeliveryForTests,
  resolveCaptureBranch,
  trackAgentSessionCapture,
} from "../agentSessionCaptureDelivery.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("agent session capture delivery barrier", () => {
  afterEach(() => {
    resetAgentSessionCaptureDeliveryForTests();
    vi.useRealTimers();
    getGitBranch.mockReset();
  });

  it("stamps the branch while the host is running normally", async () => {
    getGitBranch.mockResolvedValue("main");
    await expect(resolveCaptureBranch("/repo")).resolves.toBe("main");
    await expect(resolveCaptureBranch(undefined)).resolves.toBeNull();
  });

  it("releases a pending branch lookup the moment the host starts finishing", async () => {
    getGitBranch.mockReturnValue(new Promise<string | null>(() => {}));
    const branch = resolveCaptureBranch("/repo");

    await finishAgentSessionCaptures(0);

    await expect(branch).resolves.toBeNull();
  });

  it("waits for every registered tail, including ones registered while it waits", async () => {
    const first = deferred();
    const second = deferred();
    trackAgentSessionCapture(first.promise);

    let settled = false;
    const finish = finishAgentSessionCaptures(5_000).then((result) => {
      settled = true;
      return result;
    });

    // Trash expiry's kill fires the exit capture: one tail spawning another.
    trackAgentSessionCapture(second.promise);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    second.resolve();
    await expect(finish).resolves.toEqual({ complete: true, pending: 0 });
  });

  it("treats a rejected tail as settled rather than stalling or throwing", async () => {
    const failing = deferred();
    trackAgentSessionCapture(failing.promise);
    failing.promise.catch(() => {});
    failing.reject(new Error("boom"));

    await expect(finishAgentSessionCaptures(1_000)).resolves.toEqual({
      complete: true,
      pending: 0,
    });
  });

  it("gives up at the budget and reports what is still undelivered", async () => {
    vi.useFakeTimers();
    trackAgentSessionCapture(new Promise(() => {}));

    const finish = finishAgentSessionCaptures(750);
    await vi.advanceTimersByTimeAsync(750);

    await expect(finish).resolves.toEqual({ complete: false, pending: 1 });
  });
});
