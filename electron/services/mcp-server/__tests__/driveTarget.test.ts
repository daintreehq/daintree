import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetMcpDriveTargetResolverForTesting,
  notifyMcpDriveTargetChange,
  onMcpDriveTargetChange,
  setMcpDriveTargetResolver,
} from "../driveTarget.js";

describe("drive target changes", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    _resetMcpDriveTargetResolverForTesting();
    vi.restoreAllMocks();
  });

  it("reports routing turning on and off, and nothing from a stale disposer", () => {
    const listener = vi.fn();
    disposers.push(onMcpDriveTargetChange(listener));

    const first = setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Replaced before the first was taken down: removing it changes nothing.
    const second = setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    first();
    expect(listener).toHaveBeenCalledTimes(2);

    second();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reaches every listener when one throws, and none once disposed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const listener = vi.fn();
    const offThrowing = onMcpDriveTargetChange(throwing);
    const offListener = onMcpDriveTargetChange(listener);

    notifyMcpDriveTargetChange();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    offThrowing();
    offListener();
    notifyMcpDriveTargetChange();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
