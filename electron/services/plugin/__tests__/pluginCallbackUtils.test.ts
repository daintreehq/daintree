import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  createListenerFailureState,
  invokeTrackedListener,
} from "../pluginCallbackUtils.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invokeTrackedListener", () => {
  it("runs the callback and leaves the counter at zero on success", () => {
    const state = createListenerFailureState();
    const cb = vi.fn();
    const remove = vi.fn();
    invokeTrackedListener(state, "p", "label", cb, remove);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(state.consecutiveFailures).toBe(0);
  });

  it("removes the listener after the default number of consecutive throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();
    const cb = vi.fn(() => {
      throw new Error("boom");
    });

    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      expect(remove).not.toHaveBeenCalled();
      invokeTrackedListener(state, "p", "label", cb, remove);
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(state.consecutiveFailures).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES);
  });

  it("respects a custom threshold", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();
    const cb = () => {
      throw new Error("boom");
    };
    invokeTrackedListener(state, "p", "label", cb, remove, 1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("resets the counter after a success so intermittent failures never quarantine", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();
    let throwNext = true;
    const cb = () => {
      if (throwNext) throw new Error("boom");
    };

    // Two throws, then a success resets the counter.
    invokeTrackedListener(state, "p", "label", cb, remove);
    invokeTrackedListener(state, "p", "label", cb, remove);
    expect(state.consecutiveFailures).toBe(2);
    throwNext = false;
    invokeTrackedListener(state, "p", "label", cb, remove);
    expect(state.consecutiveFailures).toBe(0);

    // Two more throws stay under the threshold — never removed.
    throwNext = true;
    invokeTrackedListener(state, "p", "label", cb, remove);
    invokeTrackedListener(state, "p", "label", cb, remove);
    expect(remove).not.toHaveBeenCalled();
  });

  it("tracks an async callback's rejection like a synchronous throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();
    const cb = () => Promise.reject(new Error("async boom"));

    invokeTrackedListener(state, "p", "label", cb, remove);
    // The rejection settles on a microtask, so the counter updates after a tick.
    expect(state.consecutiveFailures).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.consecutiveFailures).toBe(1);
  });

  it("quarantines after consecutive async rejections", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();
    const cb = () => Promise.reject(new Error("async boom"));

    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      invokeTrackedListener(state, "p", "label", cb, remove);
      // Let each rejection settle before the next dispatch so the counter is
      // consecutive rather than racing.
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("resets the counter after an async success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn();

    invokeTrackedListener(state, "p", "label", () => Promise.reject(new Error("x")), remove);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.consecutiveFailures).toBe(1);

    invokeTrackedListener(state, "p", "label", () => Promise.resolve(), remove);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.consecutiveFailures).toBe(0);
  });

  it("swallows an error thrown by remove() so quarantine can't destabilize the loop", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createListenerFailureState();
    const remove = vi.fn(() => {
      throw new Error("remove failed");
    });
    const cb = () => {
      throw new Error("boom");
    };
    expect(() => {
      for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
        invokeTrackedListener(state, "p", "label", cb, remove);
      }
    }).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
