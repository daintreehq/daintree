import { beforeEach, describe, expect, it, vi } from "vitest";

describe("windowRecreationState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("stays true while a concurrent recreation is still in flight", async () => {
    const { beginWindowRecreating, endWindowRecreating, isWindowRecreating } =
      await import("../windowRecreationState.js");
    // Two windows OOM at once — a boolean would fail this: the first end()
    // would clear the flag while the second recreation is still running.
    beginWindowRecreating();
    beginWindowRecreating();
    endWindowRecreating();
    expect(isWindowRecreating()).toBe(true);
    endWindowRecreating();
    expect(isWindowRecreating()).toBe(false);
  });
});
