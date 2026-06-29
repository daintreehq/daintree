import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  useForgeProviderHealthStore,
  selectForgeProviderHealth,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { usePluginRuntimeStore, _resetPluginRuntimeStoreForTest } from "@/store/pluginRuntimeStore";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

const FAKE = "acme.gitlab.gitlab";

describe("forgeProviderHealthStore", () => {
  beforeEach(() => {
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  afterEach(() => {
    _resetPluginRuntimeStoreForTest();
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
      tokenHealth: null,
      providerName: null,
      pluginId: null,
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
      tokenHealth: null,
      providerName: null,
      pluginId: null,
    });
    expect(fake).toEqual({
      rateLimitBlocked: true,
      rateLimitKind: "secondary",
      rateLimitResetAt: 1_700_000_500_000,
      rateLimitMultiplier: 1,
      tokenUnhealthy: true,
      tokenBannerDismissed: false,
      tokenHealth: null,
      providerName: null,
      pluginId: null,
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

  it("stores the token-health snapshot while unhealthy and clears it on a bare recovery", () => {
    const snapshot = {
      status: "unhealthy" as const,
      tokenVersion: 2,
      checkedAt: 123,
      reauthUrl: "https://example.com/sso",
    };
    useForgeProviderHealthStore
      .getState()
      .setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true, snapshot);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenHealth
    ).toEqual(snapshot);

    // A bare "still unhealthy" push must not drop the observed snapshot.
    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenHealth?.reauthUrl
    ).toBe("https://example.com/sso");

    // A bare recovery clears it.
    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, false);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenHealth
    ).toBeNull();
  });

  it("attaches registration metadata via setProviderMeta without touching health flags", () => {
    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    useForgeProviderHealthStore.getState().setProviderMeta(BUILTIN_GITHUB_PROVIDER_ID, {
      providerName: "GitHub",
      pluginId: "daintree.github",
    });

    const gh = selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
      useForgeProviderHealthStore.getState()
    );
    expect(gh.providerName).toBe("GitHub");
    expect(gh.pluginId).toBe("daintree.github");
    expect(gh.tokenUnhealthy).toBe(true);
  });

  it("clears the banner dismissal on a fresh expiry but not on repeated unhealthy pushes", () => {
    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    useForgeProviderHealthStore.getState().dismissTokenBanner(BUILTIN_GITHUB_PROVIDER_ID);

    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenBannerDismissed
    ).toBe(true);

    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, false);
    useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, true);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenBannerDismissed
    ).toBe(false);
  });

  describe("removeProvider (#10842)", () => {
    it("drops one provider's slice and preserves the others", () => {
      const store = useForgeProviderHealthStore.getState();
      store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, { blocked: true, kind: "primary" });
      store.applyRateLimit(FAKE, { blocked: true, kind: "primary" });

      store.removeProvider(FAKE);

      // Removed provider falls back to the frozen default.
      expect(selectForgeProviderHealth(FAKE)(useForgeProviderHealthStore.getState())).toEqual(
        DEFAULT_PROVIDER_HEALTH
      );
      // The other provider is untouched.
      expect(
        selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(
          useForgeProviderHealthStore.getState()
        ).rateLimitBlocked
      ).toBe(true);
      expect(FAKE in useForgeProviderHealthStore.getState().providers).toBe(false);
    });

    it("is a no-op for an absent provider (no new object reference)", () => {
      const before = useForgeProviderHealthStore.getState().providers;
      useForgeProviderHealthStore.getState().removeProvider("never.seen.provider");
      expect(useForgeProviderHealthStore.getState().providers).toBe(before);
    });
  });

  describe("plugin-disable pruning (#10842)", () => {
    it("removes providers whose owning plugin is disabled, keeping the rest", () => {
      const store = useForgeProviderHealthStore.getState();
      store.applyRateLimit(FAKE, { blocked: true, kind: "primary" });
      store.setProviderMeta(FAKE, { providerName: "GitLab", pluginId: "acme.gitlab" });
      store.applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, { blocked: true, kind: "primary" });
      store.setProviderMeta(BUILTIN_GITHUB_PROVIDER_ID, {
        providerName: "GitHub",
        pluginId: "daintree.github",
      });

      // Disabling the GitLab plugin must evict only its provider slice.
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["acme.gitlab"]) });

      expect(FAKE in useForgeProviderHealthStore.getState().providers).toBe(false);
      expect(BUILTIN_GITHUB_PROVIDER_ID in useForgeProviderHealthStore.getState().providers).toBe(
        true
      );
    });

    it("leaves providers without a pluginId untouched when a plugin is disabled", () => {
      const store = useForgeProviderHealthStore.getState();
      // No setProviderMeta → pluginId stays null.
      store.applyRateLimit(FAKE, { blocked: true, kind: "primary" });

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["some.other.plugin"]) });

      expect(FAKE in useForgeProviderHealthStore.getState().providers).toBe(true);
    });
  });
});
