// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests exercise the singleton invariants that make `primeRadix()` safe
// to call repeatedly — once at idle warm-up (per WebContentsView) and again on
// pointer/focus gestures (#10752). The dynamic `radix-deferred` chunk is mocked
// so this stays a pure module-logic unit test with no DOM dependency.
//
// `vi.resetModules()` before each test discards the module registry so every
// case gets a fresh `radix-loader` with its `cached`/`inFlight` singletons
// reset — no state leaks between cases.

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../radix-deferred");
});

describe("primeRadix", () => {
  it("dedupes concurrent priming into a single in-flight promise", async () => {
    vi.doMock("../radix-deferred", () => ({ marker: "deferred" }));
    const { primeRadix } = await import("../radix-loader");

    const p1 = primeRadix();
    const p2 = primeRadix();

    // Same in-flight promise reference — a second call before resolution must
    // not schedule a second dynamic import.
    expect(p2).toBe(p1);

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toBe(m2);
  });

  it("caches the resolved module so later calls resolve to the same object", async () => {
    vi.doMock("../radix-deferred", () => ({ marker: "deferred" }));
    const { primeRadix, getRadixPrimitives } = await import("../radix-loader");

    const mod = await primeRadix();

    // getRadixPrimitives exposes the cached module synchronously after resolve.
    expect(getRadixPrimitives()).toBe(mod);

    const again = await primeRadix();
    expect(again).toBe(mod);
  });

  it("returns null from getRadixPrimitives before the chunk resolves", async () => {
    vi.doMock("../radix-deferred", () => ({ marker: "deferred" }));
    const { primeRadix, getRadixPrimitives } = await import("../radix-loader");

    expect(getRadixPrimitives()).toBeNull();
    const p = primeRadix();
    // Still null while the import is in flight.
    expect(getRadixPrimitives()).toBeNull();
    await p;
    expect(getRadixPrimitives()).not.toBeNull();
  });

  it("clears the in-flight singleton on rejection so the next call retries", async () => {
    vi.doMock("../radix-deferred", () => {
      throw new Error("chunk load failed");
    });
    const { primeRadix, getRadixPrimitives } = await import("../radix-loader");

    const p1 = primeRadix();
    await expect(p1).rejects.toThrow();

    // Failure must not be cached as a successful module.
    expect(getRadixPrimitives()).toBeNull();

    // A subsequent call creates a fresh promise rather than reusing the
    // rejected one — this is what lets a later gesture retry after a transient
    // chunk-load failure instead of being permanently broken.
    const p2 = primeRadix();
    expect(p2).not.toBe(p1);
    await expect(p2).rejects.toThrow();
  });
});
