import { describe, it, expect, beforeEach } from "vitest";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";

describe("githubRateLimitStore", () => {
  beforeEach(() => {
    // The shim holds no state of its own — reset the backing provider-keyed
    // store instead.
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  it("starts in the unblocked state", () => {
    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(false);
    expect(state.kind).toBeNull();
    expect(state.resetAt).toBeNull();
  });

  it("applies a primary-block payload with all fields", () => {
    const resetAt = Date.now() + 60_000;
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "primary",
      resetAt,
      resource: "core",
    });

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("primary");
    expect(state.resetAt).toBe(resetAt);
  });

  it("applies a secondary-block payload", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "secondary",
      resetAt: 1_700_000_000_000,
    });

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("secondary");
    expect(state.resetAt).toBe(1_700_000_000_000);
  });

  it("normalizes missing resetAt to null on blocked payloads", () => {
    useGitHubRateLimitStore.getState().apply({ blocked: true, kind: "secondary" });
    expect(useGitHubRateLimitStore.getState().resetAt).toBeNull();
  });

  it("clears kind and resetAt when an unblocked payload arrives", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "primary",
      resetAt: 1_700_000_000_000,
    });
    useGitHubRateLimitStore.getState().apply({ blocked: false, kind: null });

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(false);
    expect(state.kind).toBeNull();
    expect(state.resetAt).toBeNull();
  });

  it("replaces stale state on repeated apply() calls", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "primary",
      resetAt: 1_700_000_000_000,
    });
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "secondary",
      resetAt: 1_700_000_500_000,
    });

    const state = useGitHubRateLimitStore.getState();
    expect(state.kind).toBe("secondary");
    expect(state.resetAt).toBe(1_700_000_500_000);
  });
});
