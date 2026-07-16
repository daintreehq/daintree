// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProjectViewCacheStateForTests,
  isProjectViewCached,
  subscribeProjectViewLifecycle,
} from "../viewCacheState";

/**
 * `TerminalInstanceService` builds its controllers at module scope, so every
 * suite that imports anything downstream of it — action definitions, the panel
 * registry, worktree stores — evaluates this module too. Many of those run under
 * the node environment, where `window` is undeclared rather than empty: a bare
 * read throws a ReferenceError that `?.` cannot catch, and the whole suite fails
 * to load. jsdom-only coverage cannot see this.
 */
describe("viewCacheState without a DOM", () => {
  afterEach(() => {
    __resetProjectViewCacheStateForTests();
  });

  it("does not throw when window is undeclared", () => {
    expect(typeof window).toBe("undefined");
    expect(() => isProjectViewCached()).not.toThrow();
  });

  it("reports not-cached — no window means no view lifecycle", () => {
    expect(isProjectViewCached()).toBe(false);
  });

  it("allows subscribing and unsubscribing without a DOM", () => {
    let off: (() => void) | undefined;
    expect(() => {
      off = subscribeProjectViewLifecycle(() => {});
    }).not.toThrow();
    expect(() => off?.()).not.toThrow();
  });

  it("survives a reset with no bridge to detach", () => {
    subscribeProjectViewLifecycle(() => {});
    expect(() => __resetProjectViewCacheStateForTests()).not.toThrow();
    expect(isProjectViewCached()).toBe(false);
  });
});
