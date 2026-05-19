// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useForgeAuthorAvatar } from "../useForgeAuthorAvatar";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

const resolveAuthorAvatar = vi.fn();

beforeEach(() => {
  resolveAuthorAvatar.mockReset();
  (globalThis as { window: Window }).window.electron = {
    github: { resolveAuthorAvatar },
  } as unknown as Window["electron"];
});

describe("useForgeAuthorAvatar", () => {
  it("returns undefined while loading, then the resolved URL", async () => {
    resolveAuthorAvatar.mockResolvedValue("https://avatars.example/u/1");
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({
        email: "dev@example.com",
        linkedProviderId: BUILTIN_GITHUB_PROVIDER_ID,
      })
    );
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe("https://avatars.example/u/1"));
    expect(resolveAuthorAvatar).toHaveBeenCalledWith("dev@example.com");
  });

  it("does not call the provider for a non-GitHub forge", () => {
    renderHook(() =>
      useForgeAuthorAvatar({ email: "dev@example.com", linkedProviderId: "gitlab.gitlab" })
    );
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("does not call the provider when there is no linked provider", () => {
    renderHook(() =>
      useForgeAuthorAvatar({ email: "dev@example.com", linkedProviderId: undefined })
    );
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("does not call the provider for an empty email", () => {
    renderHook(() =>
      useForgeAuthorAvatar({ email: "   ", linkedProviderId: BUILTIN_GITHUB_PROVIDER_ID })
    );
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
  });

  it("normalizes a legacy provider id before routing", async () => {
    resolveAuthorAvatar.mockResolvedValue("https://avatars.example/legacy");
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({ email: "dev@example.com", linkedProviderId: "github" })
    );
    await waitFor(() => expect(result.current).toBe("https://avatars.example/legacy"));
  });

  it("stays undefined when the provider resolves null", async () => {
    resolveAuthorAvatar.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({
        email: "nobody@example.com",
        linkedProviderId: BUILTIN_GITHUB_PROVIDER_ID,
      })
    );
    await waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("swallows provider rejection and stays undefined", async () => {
    resolveAuthorAvatar.mockRejectedValue(new Error("ipc failed"));
    const { result } = renderHook(() =>
      useForgeAuthorAvatar({
        email: "dev@example.com",
        linkedProviderId: BUILTIN_GITHUB_PROVIDER_ID,
      })
    );
    await waitFor(() => expect(resolveAuthorAvatar).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("clears the avatar when the forge changes from GitHub to non-GitHub", async () => {
    resolveAuthorAvatar.mockResolvedValue("https://avatars.example/u/1");
    const { result, rerender } = renderHook(
      ({ provider }) =>
        useForgeAuthorAvatar({ email: "dev@example.com", linkedProviderId: provider }),
      { initialProps: { provider: BUILTIN_GITHUB_PROVIDER_ID as string } }
    );
    await waitFor(() => expect(result.current).toBe("https://avatars.example/u/1"));

    resolveAuthorAvatar.mockClear();
    rerender({ provider: "gitlab.gitlab" });
    expect(result.current).toBeUndefined();
    expect(resolveAuthorAvatar).not.toHaveBeenCalled();
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
      ({ email }) => useForgeAuthorAvatar({ email, linkedProviderId: BUILTIN_GITHUB_PROVIDER_ID }),
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
