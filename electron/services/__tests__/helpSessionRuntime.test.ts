import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelpSessionService } from "../HelpSessionService.js";
import {
  loadedHelpSessionService,
  publishHelpSessionService,
  resetHelpSessionRuntimeForTests,
  whenHelpSessionServiceLoads,
} from "../helpSessionRuntime.js";

const service = (name: string) => ({ name }) as unknown as HelpSessionService;

describe("helpSessionRuntime", () => {
  afterEach(() => {
    resetHelpSessionRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("reads as not loaded until the service publishes itself", () => {
    expect(loadedHelpSessionService()).toBeNull();
    const loaded = service("a");
    publishHelpSessionService(loaded);
    expect(loadedHelpSessionService()).toBe(loaded);
  });

  it("holds wiring until the service loads, then applies it once, in registration order", () => {
    const order: string[] = [];
    const first = vi.fn(() => order.push("first"));
    const second = vi.fn(() => order.push("second"));
    whenHelpSessionServiceLoads(first);
    whenHelpSessionServiceLoads(second);
    expect(first).not.toHaveBeenCalled();

    const loaded = service("a");
    publishHelpSessionService(loaded);
    expect(order).toEqual(["first", "second"]);
    expect(first).toHaveBeenCalledWith(loaded);

    publishHelpSessionService(service("b"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("applies wiring at once when the service has already loaded", () => {
    const loaded = service("a");
    publishHelpSessionService(loaded);
    const apply = vi.fn();
    whenHelpSessionServiceLoads(apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(loaded);
  });

  it("drops wiring cancelled before the service loads", () => {
    const apply = vi.fn();
    const cancel = whenHelpSessionServiceLoads(apply);
    cancel();
    publishHelpSessionService(service("a"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("still applies the rest when one piece of wiring throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const after = vi.fn();
    whenHelpSessionServiceLoads(() => {
      throw new Error("boom");
    });
    whenHelpSessionServiceLoads(after);
    publishHelpSessionService(service("a"));
    expect(after).toHaveBeenCalledTimes(1);
  });
});
