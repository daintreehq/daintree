// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAuthorAvatar = vi.fn();
const resolvedProvider = vi.hoisted(() => ({
  entry: null as unknown,
  providerId: null as string | null,
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
  useResolvedForgeProvider: () => ({
    entry: resolvedProvider.entry,
    providerId: resolvedProvider.providerId,
    resolvedVia: null,
    loading: false,
    refresh: vi.fn(),
  }),
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
});
