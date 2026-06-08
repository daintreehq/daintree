import { describe, it, expect, beforeEach } from "vitest";
import {
  useForgeProviderHealthStore,
  selectForgeProviderHealth,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

const FAKE = "acme.gitlab.gitlab";

describe("forgeProviderHealthStore", () => {
  beforeEach(() => {
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  it("returns the default health for an unseen provider", () => {
    const health = selectForgeProviderHealth(FAKE)(useForgeProviderHealthStore.getState());
    expect(health).toEqual(DEFAULT_PROVIDER_HEALTH);
  });

  it("applies a primary rate-limit block to one provider only", () => {
    const resetAt = Date.now() + 60_000;
    useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: true,
      kind: "primary",
      resetAt,
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh).toEqual({
      rateLimitBlocked: true,
      rateLimitKind: "primary",
      rateLimitResetAt: resetAt,
      rateLimitMultiplier: 1,
      tokenUnhealthy: false,
      tokenBannerDismissed: false,
    });
  });

  it("does not cross-contaminate: GitHub and a fake provider keep separate state", () => {
    const store = useForgeProviderHealthStore.getState();

    store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: true,
      kind: "primary",
      resetAt: 1_700_000_000_000,
    });
    store.applyRateLimit(FAKE, { blocked: true, kind: "secondary", resetAt: 1_700_000_500_000 });
    store.setTokenUnhealthy(FAKE, true);

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    const fake = selectForgeProviderHealth(FAKE)(useForgeProviderHealthStore.getState());

    // GitHub keeps its own rate-limit kind and is NOT marked token-unhealthy
    // by the fake provider's token-health update.
    expect(gh).toEqual({
      rateLimitBlocked: true,
      rateLimitKind: "primary",
      rateLimitResetAt: 1_700_000_000_000,
      rateLimitMultiplier: 1,
      tokenUnhealthy: false,
      tokenBannerDismissed: false,
    });
    expect(fake).toEqual({
      rateLimitBlocked: true,
      rateLimitKind: "secondary",
      rateLimitResetAt: 1_700_000_500_000,
      rateLimitMultiplier: 1,
      tokenUnhealthy: true,
      tokenBannerDismissed: false,
    });
  });

  it("clearing one provider's block leaves the other provider blocked", () => {
    const store = useForgeProviderHealthStore.getState();
    store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: true,
      kind: "primary",
      resetAt: 123,
    });
    store.applyRateLimit(FAKE, { blocked: true, kind: "primary", resetAt: 456 });

    store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, { blocked: false, kind: null });

    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .rateLimitBlocked
    ).toBe(false);
    expect(
      selectForgeProviderHealth(FAKE)(useForgeProviderHealthStore.getState()).rateLimitBlocked
    ).toBe(true);
  });

  it("token-health and rate-limit are independent fields within a provider", () => {
    const store = useForgeProviderHealthStore.getState();
    store.setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: true,
      kind: "secondary",
      resetAt: 999,
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh.tokenUnhealthy).toBe(true);
    expect(gh.rateLimitBlocked).toBe(true);

    store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, { blocked: false, kind: null });
    const after = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    // Clearing the rate limit must not reset the token-health flag.
    expect(after.tokenUnhealthy).toBe(true);
    expect(after.rateLimitBlocked).toBe(false);
  });

  it("normalizes missing resetAt to null on a blocked apply", () => {
    useForgeProviderHealthStore
      .getState()
      .applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, { blocked: true, kind: "secondary" });
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .rateLimitResetAt
    ).toBeNull();
  });

  it("returns an immutable default for unseen providers (no shared mutation)", () => {
    const a = selectForgeProviderHealth("p.one.one")(useForgeProviderHealthStore.getState());
    expect(() => {
      a.rateLimitBlocked = true;
    }).toThrow();
    const b = selectForgeProviderHealth("p.two.two")(useForgeProviderHealthStore.getState());
    expect(b.rateLimitBlocked).toBe(false);
  });

  it("produces a new providers object reference on every mutation", () => {
    const before = useForgeProviderHealthStore.getState().providers;
    useForgeProviderHealthStore
      .getState()
      .applyRateLimit(FAKE, { blocked: true, kind: "primary", resetAt: 1 });
    const after = useForgeProviderHealthStore.getState().providers;
    expect(after).not.toBe(before);
  });

  it("stores rateLimitMultiplier even when not blocked", () => {
    useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: false,
      kind: null,
      throttleMultiplier: 5,
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh.rateLimitBlocked).toBe(false);
    expect(gh.rateLimitMultiplier).toBe(5);
  });

  it("clamps non-finite throttleMultiplier to 1", () => {
    useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: false,
      kind: null,
      throttleMultiplier: Infinity,
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh.rateLimitMultiplier).toBe(1);
  });

  it("clamps throttleMultiplier below 1 to 1", () => {
    useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
      blocked: false,
      kind: null,
      throttleMultiplier: 0.5,
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh.rateLimitMultiplier).toBe(1);
  });
});
