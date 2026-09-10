// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const getRepoUrlMock = vi.hoisted(() => vi.fn<(cwd: string) => Promise<string | null>>());

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getRepoUrl: (cwd: string) => getRepoUrlMock(cwd) },
}));

import { useCanOpenForgeRepo } from "../useCanOpenForgeRepo";

function deferred<T>() {
  const handlers: { resolve: (value: T) => void; reject: (reason: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return { promise, ...handlers };
}

beforeEach(() => {
  getRepoUrlMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useCanOpenForgeRepo", () => {
  it("turns true once the provider returns a repository URL", async () => {
    const lookup = deferred<string | null>();
    getRepoUrlMock.mockReturnValue(lookup.promise);

    const { result } = renderHook(() => useCanOpenForgeRepo("/repo", "acme.forge"));
    expect(result.current).toBe(false);

    await act(async () => lookup.resolve("https://forge.test/acme/widgets"));

    expect(result.current).toBe(true);
    expect(getRepoUrlMock).toHaveBeenCalledWith("/repo");
  });

  it("stays false when the provider has no repository page", async () => {
    const lookup = deferred<string | null>();
    getRepoUrlMock.mockReturnValue(lookup.promise);

    const { result } = renderHook(() => useCanOpenForgeRepo("/repo", "acme.forge"));
    await act(async () => lookup.resolve(null));

    expect(result.current).toBe(false);
  });

  it("stays false when the lookup fails, without letting the rejection escape", async () => {
    const lookup = deferred<string | null>();
    getRepoUrlMock.mockReturnValue(lookup.promise);

    const { result } = renderHook(() => useCanOpenForgeRepo("/repo", "acme.forge"));
    await act(async () => lookup.reject(new Error("No remote URL found for this repository")));

    expect(result.current).toBe(false);
  });

  it("asks nothing while the project has no resolved provider", () => {
    const { result } = renderHook(() => useCanOpenForgeRepo("/repo", null));

    expect(result.current).toBe(false);
    expect(getRepoUrlMock).not.toHaveBeenCalled();
  });

  it("drops the previous provider's answer the moment the provider changes", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    getRepoUrlMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ providerId }: { providerId: string }) => useCanOpenForgeRepo("/repo", providerId),
      { initialProps: { providerId: "acme.github" } }
    );
    await act(async () => first.resolve("https://github.com/acme/widgets"));
    expect(result.current).toBe(true);

    rerender({ providerId: "acme.bare" });
    expect(result.current).toBe(false);

    await act(async () => second.resolve(null));
    expect(result.current).toBe(false);
  });

  it("ignores an answer that lands after the project changed", async () => {
    const stale = deferred<string | null>();
    const current = deferred<string | null>();
    getRepoUrlMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);

    const { result, rerender } = renderHook(
      ({ projectPath }: { projectPath: string }) => useCanOpenForgeRepo(projectPath, "acme.forge"),
      { initialProps: { projectPath: "/old" } }
    );
    rerender({ projectPath: "/new" });

    await act(async () => stale.resolve("https://forge.test/acme/old"));
    expect(result.current).toBe(false);

    await act(async () => current.resolve("https://forge.test/acme/new"));
    expect(result.current).toBe(true);
    expect(getRepoUrlMock).toHaveBeenLastCalledWith("/new");
  });
});
