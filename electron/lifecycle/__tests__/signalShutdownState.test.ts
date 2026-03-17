import { beforeEach, describe, expect, it, vi } from "vitest";

describe("signalShutdownState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts as false", async () => {
    const { isSignalShutdown } = await import("../signalShutdownState.js");
    expect(isSignalShutdown()).toBe(false);
  });

  it("becomes true after setSignalShutdown", async () => {
    const { isSignalShutdown, setSignalShutdown } = await import(
      "../signalShutdownState.js"
    );
    setSignalShutdown();
    expect(isSignalShutdown()).toBe(true);
  });
});
