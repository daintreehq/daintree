/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ForgePullRequestTerm } from "@shared/types/forge";

const getPullRequestTermMock = vi.hoisted(() =>
  vi.fn<(providerId: string) => Promise<ForgePullRequestTerm | null>>()
);

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getPullRequestTerm: getPullRequestTermMock },
}));

vi.mock("@/utils/logger", () => ({ logDebug: vi.fn() }));

import { _resetPullRequestTermsForTest, usePullRequestTerm } from "../usePullRequestTerm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  getPullRequestTermMock.mockReset();
  _resetPullRequestTermsForTest();
});

afterEach(cleanup);

describe("usePullRequestTerm", () => {
  it("reads as a pull request until the provider answers, then uses its word", async () => {
    const answer = deferred<ForgePullRequestTerm | null>();
    getPullRequestTermMock.mockReturnValue(answer.promise);

    const { result } = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));
    expect(result.current).toBe("pull-request");

    await act(async () => answer.resolve("merge-request"));
    expect(result.current).toBe("merge-request");
    expect(getPullRequestTermMock).toHaveBeenCalledWith("daintree.gitlab.gitlab");
  });

  it("asks each provider once, and answers a later mount from the first answer", async () => {
    getPullRequestTermMock.mockResolvedValue("merge-request");
    const first = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));
    await waitFor(() => expect(first.result.current).toBe("merge-request"));
    first.unmount();

    const second = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));

    expect(second.result.current).toBe("merge-request");
    expect(getPullRequestTermMock).toHaveBeenCalledTimes(1);
  });

  it("asks nothing without a provider", () => {
    const { result } = renderHook(() => usePullRequestTerm(null));

    expect(result.current).toBe("pull-request");
    expect(getPullRequestTermMock).not.toHaveBeenCalled();
  });

  it("stays a pull request when the lookup fails, and asks again next time", async () => {
    getPullRequestTermMock.mockRejectedValueOnce(new Error("offline"));
    const first = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));
    await act(async () => undefined);
    expect(first.result.current).toBe("pull-request");
    first.unmount();

    getPullRequestTermMock.mockResolvedValueOnce(null);
    const second = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));
    await act(async () => undefined);
    expect(second.result.current).toBe("pull-request");
    second.unmount();

    getPullRequestTermMock.mockResolvedValueOnce("merge-request");
    const third = renderHook(() => usePullRequestTerm("daintree.gitlab.gitlab"));
    await waitFor(() => expect(third.result.current).toBe("merge-request"));
    expect(getPullRequestTermMock).toHaveBeenCalledTimes(3);
  });

  it("never shows one provider's word for another", async () => {
    const gitlab = deferred<ForgePullRequestTerm | null>();
    getPullRequestTermMock.mockImplementation((providerId) =>
      providerId === "daintree.gitlab.gitlab" ? gitlab.promise : new Promise(() => undefined)
    );
    const { result, rerender } = renderHook(({ id }) => usePullRequestTerm(id), {
      initialProps: { id: "daintree.gitlab.gitlab" as string | null },
    });

    rerender({ id: "github" });
    await act(async () => gitlab.resolve("merge-request"));

    expect(result.current).toBe("pull-request");
  });
});
