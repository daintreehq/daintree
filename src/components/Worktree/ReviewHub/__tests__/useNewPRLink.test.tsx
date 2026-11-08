/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
  head: "topic",
  base: "develop",
  baseRef: "origin/develop",
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
      base: "develop",
      baseRef: "origin/develop",
    });

    reply.resolve(READY);
    await waitFor(() => expect(result.current).toEqual(READY));
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

    second.resolve(UNPUSHED);
    await waitFor(() => expect(result.current).toEqual(UNPUSHED));

    first.resolve(READY);
    await first.promise;
    await Promise.resolve();
    expect(result.current).toEqual(UNPUSHED);
  });

  it("drops the answer the moment the branch or base changes", async () => {
    getNewPRLinkMock.mockResolvedValueOnce(READY);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current).toEqual(READY));

    getNewPRLinkMock.mockReturnValue(new Promise(() => undefined));
    rerender({ ...OPTIONS, head: "other" });
    expect(result.current).toBeNull();

    getNewPRLinkMock.mockResolvedValueOnce(READY);
    rerender({ ...OPTIONS, head: "other", base: "main" });
    expect(result.current).toBeNull();
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

    again.resolve(READY);
    await waitFor(() => expect(result.current).toEqual(READY));
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
    again.reject(new Error("rate limited"));
    await again.promise.catch(() => undefined);
    await Promise.resolve();

    expect(result.current).toEqual(READY);
  });
});
