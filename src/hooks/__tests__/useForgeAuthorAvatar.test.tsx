// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAuthorAvatar = vi.fn();
const resolvedProvider = vi.hoisted(() => ({
  entry: null as unknown,
  providerId: null as string | null,
  askedFor: [] as Array<string | null | undefined>,
}));

vi.mock("@/clients", () => ({
  forgeClient: {
    resolveAuthorAvatar: (...args: unknown[]) => resolveAuthorAvatar(...args),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { id: "project-1", path: "/repo" } }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: (projectId: string | null | undefined) => {
    resolvedProvider.askedFor.push(projectId);
    return projectId
      ? {
          entry: resolvedProvider.entry,
          providerId: resolvedProvider.providerId,
          resolvedVia: null,
          loading: false,
          refresh: vi.fn(),
        }
      : { entry: null, providerId: null, resolvedVia: null, loading: false, refresh: vi.fn() };
  },
}));

import { useForgeAuthorAvatar } from "../useForgeAuthorAvatar";

function setProviderResolved(resolved: boolean) {
  resolvedProvider.entry = resolved
    ? { pluginId: "daintree.github", contribution: { id: "github", name: "GitHub" } }
    : null;
  resolvedProvider.providerId = resolved ? "daintree.github.github" : null;
}

beforeEach(() => {
  resolveAuthorAvatar.mockReset();
  resolvedProvider.askedFor = [];
  setProviderResolved(true);
});

describe("useForgeAuthorAvatar", () => {
  it("returns undefined while loading, then the resolved URL", async () => {
    resolveAuthorAvatar.mockResolvedValue("https://avatars.example/u/1");
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({ email: "dev@example.com", cwd: "/repo/wt" })
    );
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe("https://avatars.example/u/1"));
    expect(resolveAuthorAvatar).toHaveBeenCalledWith("/repo/wt", "dev@example.com");
  });

  it("does not call the provider when no forge provider resolves", () => {
    setProviderResolved(false);
    renderHook(() => useForgeAuthorAvatar({ email: "dev@example.com", cwd: "/repo/wt" }));
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("does not call the provider without a cwd", () => {
    renderHook(() => useForgeAuthorAvatar({ email: "dev@example.com", cwd: undefined }));
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("does not call the provider for an empty email", () => {
    renderHook(() => useForgeAuthorAvatar({ email: "   ", cwd: "/repo/wt" }));
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("stays undefined when the provider resolves null", async () => {
    resolveAuthorAvatar.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({ email: "nobody@example.com", cwd: "/repo/wt" })
    );
    await waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("swallows provider rejection and stays undefined", async () => {
    resolveAuthorAvatar.mockRejectedValue(new Error("ipc failed"));
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({ email: "dev@example.com", cwd: "/repo/wt" })
    );
    await waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("does not apply a stale response after the email changes", async () => {
    let resolveFirst: (v: string) => void = () => {};
    resolveAuthorAvatar.mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          resolveFirst = res;
        })
    );
    resolveAuthorAvatar.mockResolvedValueOnce("https://avatars.example/second");

    const { result, rerender } = renderHook(
      ({ email }) => useForgeAuthorAvatar({ email, cwd: "/repo/wt" }),
      { initialProps: { email: "first@example.com" } }
    );

    rerender({ email: "second@example.com" });
    await waitFor(() => expect(result.current).toBe("https://avatars.example/second"));

    // The first lookup resolves late — its cleanup-cancelled callback must not
    // clobber the second email's avatar.
    resolveFirst("https://avatars.example/first");
    await Promise.resolve();
    expect(result.current).toBe("https://avatars.example/second");
  });

  describe("enabled: false (#17072)", () => {
    it("asks for neither the avatar nor the project's provider", () => {
      resolveAuthorAvatar.mockResolvedValue("https://avatars.example/u/1");
      const { result } = renderHook(() =>
        useForgeAuthorAvatar({ email: "dev@example.com", cwd: "/repo/wt", enabled: false })
      );
      expect(result.current).toBeUndefined();
      expect(resolveAuthorAvatar).not.toHaveBeenCalled();
      expect(resolvedProvider.askedFor.every((id) => id === null)).toBe(true);
    });

    it("fetches once enabled, and drops a lookup still out when disabled again", async () => {
      let release: (url: string) => void = () => {};
      resolveAuthorAvatar.mockImplementationOnce(
        () =>
          new Promise<string>((res) => {
            release = res;
          })
      );
      const { result, rerender } = renderHook(
        ({ enabled }) =>
          useForgeAuthorAvatar({ email: "dev@example.com", cwd: "/repo/wt", enabled }),
        { initialProps: { enabled: false } }
      );
      rerender({ enabled: true });
      await waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalledTimes(1));
      expect(resolvedProvider.askedFor.at(-1)).toBe("project-1");

      rerender({ enabled: false });
      await act(async () => {
        release("https://avatars.example/late");
      });
      expect(result.current).toBeUndefined();
    });
  });
});
