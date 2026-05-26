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
    expect(state.throttleMultiplier).toBe(1);
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

  it("clears kind and resetAt but preserves throttleMultiplier when an unblocked payload arrives", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: true,
      kind: "primary",
      resetAt: 1_700_000_000_000,
      throttleMultiplier: 5,
    });
    useGitHubRateLimitStore.getState().apply({ blocked: false, kind: null, throttleMultiplier: 3 });

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(false);
    expect(state.kind).toBeNull();
    expect(state.resetAt).toBeNull();
    expect(state.throttleMultiplier).toBe(3);
  });

  it("delegates .setState through to the backing keyed store", () => {
    useGitHubRateLimitStore.setState({ blocked: true, kind: "primary", resetAt: 123 });

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("primary");
    expect(state.resetAt).toBe(123);

    const slice = useForgeProviderHealthStore.getState().providers["daintree.github.github"];
    expect(slice).toMatchObject({
      rateLimitBlocked: true,
      rateLimitKind: "primary",
      rateLimitResetAt: 123,
    });
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

  it("forwards throttleMultiplier through apply() to the backing forge store", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: false,
      kind: null,
      throttleMultiplier: 7,
    });

    const state = useGitHubRateLimitStore.getState();
    expect(state.throttleMultiplier).toBe(7);
    expect(state.blocked).toBe(false);

    const slice = useForgeProviderHealthStore.getState().providers["daintree.github.github"];
    expect(slice?.rateLimitMultiplier).toBe(7);
  });

  it("defaults throttleMultiplier to 1 when payload omits it", () => {
    useGitHubRateLimitStore.getState().apply({ blocked: false, kind: null });

    const state = useGitHubRateLimitStore.getState();
    expect(state.throttleMultiplier).toBe(1);
  });

  it("clamps non-finite throttleMultiplier to 1", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: false,
      kind: null,
      throttleMultiplier: NaN,
    });

    expect(useGitHubRateLimitStore.getState().throttleMultiplier).toBe(1);
  });

  it("clamps throttleMultiplier below 1 to 1", () => {
    useGitHubRateLimitStore.getState().apply({
      blocked: false,
      kind: null,
      throttleMultiplier: 0,
    });

    expect(useGitHubRateLimitStore.getState().throttleMultiplier).toBe(1);
  });
});
