/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ForgeNewPRLink } from "@shared/types/ipc/forge";

const getNewPRLinkMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getNewPRLink: getNewPRLinkMock },
}));

vi.mock("@/utils/logger", () => ({ logDebug: vi.fn() }));

import { useNewPRLink } from "../useNewPRLink";

const READY: ForgeNewPRLink = {
  state: "ready",
  term: "merge-request",
  url: "https://forge.test/new",
};
const UNPUSHED: ForgeNewPRLink = { state: "unpushed", term: "pull-request" };

const OPTIONS = {
  enabled: true,
  revision: "r1",
  cwd: "/repo/wt",
  head: "topic" as string | null,
  baseRef: "origin/develop" as string | null,
  isMainWorktree: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(initial = OPTIONS) {
  return renderHook((props: typeof OPTIONS) => useNewPRLink(props), { initialProps: initial });
}

afterEach(cleanup);

describe("useNewPRLink", () => {
  beforeEach(() => {
    getNewPRLinkMock.mockReset();
  });

  it("asks about this branch and answers null until the reply lands", async () => {
    const reply = deferred<ForgeNewPRLink>();
    getNewPRLinkMock.mockReturnValue(reply.promise);

    const { result } = setup();

    expect(result.current).toBeNull();
    expect(getNewPRLinkMock).toHaveBeenCalledWith({
      cwd: "/repo/wt",
      head: "topic",
      baseRef: "origin/develop",
      isMainWorktree: false,
    });

    await act(async () => reply.resolve(READY));
    expect(result.current).toEqual(READY);
  });

  it("asks nothing while disabled", () => {
    const { result } = setup({ ...OPTIONS, enabled: false });

    expect(getNewPRLinkMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("never shows one branch's answer for another, however late it lands", async () => {
    const first = deferred<ForgeNewPRLink>();
    const second = deferred<ForgeNewPRLink>();
    getNewPRLinkMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = setup();
    rerender({ ...OPTIONS, head: "other" });

    await act(async () => second.resolve(UNPUSHED));
    expect(result.current).toEqual(UNPUSHED);

    // Without the cancellation this overwrites the newer answer, and the
    // identity check then turns the result back into null.
    await act(async () => first.resolve(READY));
    expect(result.current).toEqual(UNPUSHED);
  });

  it.each([
    { name: "worktree", change: { cwd: "/repo/other" } },
    { name: "branch", change: { head: "other" } },
    { name: "base", change: { baseRef: "origin/main" } },
    { name: "worktree kind", change: { isMainWorktree: true } },
  ])("drops the answer the moment the $name changes", async ({ change }) => {
    getNewPRLinkMock.mockResolvedValueOnce(READY);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current).toEqual(READY));

    getNewPRLinkMock.mockReturnValue(new Promise(() => undefined));
    rerender({ ...OPTIONS, ...change });

    expect(result.current).toBeNull();
    expect(getNewPRLinkMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the last answer standing while a push or fetch asks again", async () => {
    getNewPRLinkMock.mockResolvedValueOnce(UNPUSHED);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current).toEqual(UNPUSHED));

    const again = deferred<ForgeNewPRLink>();
    getNewPRLinkMock.mockReturnValueOnce(again.promise);
    rerender({ ...OPTIONS, revision: "r2" });

    expect(getNewPRLinkMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(UNPUSHED);

    await act(async () => again.resolve(READY));
    expect(result.current).toEqual(READY);
  });

  it("reads a failed lookup as nothing to offer, not as an unpushed branch", async () => {
    getNewPRLinkMock.mockRejectedValueOnce(new Error("rate limited"));

    const { result } = setup();

    await waitFor(() =>
      expect(result.current).toEqual({ state: "unavailable", term: "pull-request" })
    );
  });

  it("keeps a good answer through a failed re-ask", async () => {
    getNewPRLinkMock.mockResolvedValueOnce(READY);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current).toEqual(READY));

    const again = deferred<ForgeNewPRLink>();
    getNewPRLinkMock.mockReturnValueOnce(again.promise);
    rerender({ ...OPTIONS, revision: "r2" });

    await act(async () => again.reject(new Error("rate limited")));
    expect(result.current).toEqual(READY);
  });
});
