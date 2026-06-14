import { describe, expect, it } from "vitest";
import { PluginMcpRateLimiter } from "../PluginMcpRateLimiter.js";

/**
 * A controllable clock so refill behaviour is deterministic without fake
 * timers — the limiter reads wall-clock only through the injected `now`.
 */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("PluginMcpRateLimiter", () => {
  it("allows a burst up to capacity then throttles", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(20, 1, clock.now);

    for (let i = 0; i < 20; i++) {
      expect(limiter.check("acme", "main").allowed).toBe(true);
    }
    const throttled = limiter.check("acme", "main");
    expect(throttled.allowed).toBe(false);
    if (!throttled.allowed) {
      expect(throttled.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("refills steadily at the configured rate", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(20, 1, clock.now);

    for (let i = 0; i < 20; i++) limiter.check("acme", "main");
    expect(limiter.check("acme", "main").allowed).toBe(false);

    // One token regenerates after 1s at 1 token/sec.
    clock.advance(1000);
    expect(limiter.check("acme", "main").allowed).toBe(true);
    // ...and it was exactly one — the very next call is throttled again.
    expect(limiter.check("acme", "main").allowed).toBe(false);
  });

  it("never refills beyond capacity", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(5, 1, clock.now);

    // Idle far longer than capacity/refill would imply.
    clock.advance(60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("acme", "main").allowed).toBe(true);
    }
    expect(limiter.check("acme", "main").allowed).toBe(false);
  });

  it("reports a retryAfterMs consistent with the refill rate", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(1, 2, clock.now); // 2 tokens/sec

    expect(limiter.check("acme", "main").allowed).toBe(true);
    const throttled = limiter.check("acme", "main");
    expect(throttled.allowed).toBe(false);
    if (!throttled.allowed) {
      // One token at 2/sec ≈ 500ms.
      expect(throttled.retryAfterMs).toBe(500);
    }
  });

  it("isolates buckets per (pluginId, serverId)", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(1, 1, clock.now);

    expect(limiter.check("acme", "main").allowed).toBe(true);
    // Different server on the same plugin is independent.
    expect(limiter.check("acme", "other").allowed).toBe(true);
    // Different plugin is independent.
    expect(limiter.check("beta", "main").allowed).toBe(true);
    // The original pair is now empty.
    expect(limiter.check("acme", "main").allowed).toBe(false);
  });

  it("does not collide pairs whose ids contain the separator", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(1, 1, clock.now);

    // A naive `${pluginId}:${serverId}` key would merge ("a:b","c") with
    // ("a","b:c"). Nested-map keying keeps them distinct.
    expect(limiter.check("a:b", "c").allowed).toBe(true);
    expect(limiter.check("a", "b:c").allowed).toBe(true);
    expect(limiter.check("a:b", "c").allowed).toBe(false);
  });

  it("dropServer resets a single server's bucket", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(1, 1, clock.now);

    limiter.check("acme", "main");
    expect(limiter.check("acme", "main").allowed).toBe(false);

    limiter.dropServer("acme", "main");
    expect(limiter.check("acme", "main").allowed).toBe(true);
  });

  it("dropPlugin resets every bucket for the plugin", () => {
    const clock = makeClock();
    const limiter = new PluginMcpRateLimiter(1, 1, clock.now);

    limiter.check("acme", "main");
    limiter.check("acme", "other");
    expect(limiter.check("acme", "main").allowed).toBe(false);
    expect(limiter.check("acme", "other").allowed).toBe(false);

    limiter.dropPlugin("acme");
    expect(limiter.check("acme", "main").allowed).toBe(true);
    expect(limiter.check("acme", "other").allowed).toBe(true);
  });
});
