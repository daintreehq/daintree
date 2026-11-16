import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetHostFiguresDemandForTesting,
  areHostFiguresFollowed,
  onHostFiguresDemandChange,
  setHostFiguresFollowed,
} from "../hostFiguresDemand.js";

afterEach(() => _resetHostFiguresDemandForTesting());

describe("hostFiguresDemand", () => {
  it("is followed while any view follows, and says so only when that changes", () => {
    const heard = vi.fn();
    onHostFiguresDemandChange(heard);

    setHostFiguresFollowed(1, true);
    expect(areHostFiguresFollowed()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);

    // A second view, and a view repeating itself, change nothing.
    setHostFiguresFollowed(2, true);
    setHostFiguresFollowed(1, true);
    expect(heard).toHaveBeenCalledTimes(1);

    setHostFiguresFollowed(1, false);
    expect(areHostFiguresFollowed()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);

    setHostFiguresFollowed(2, false);
    expect(areHostFiguresFollowed()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);

    // Releasing a view that never followed is a no-op.
    setHostFiguresFollowed(3, false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("stops telling a listener once it unsubscribes, and survives one that throws", () => {
    const failing = vi.fn(() => {
      throw new Error("listener broke");
    });
    const heard = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onHostFiguresDemandChange(failing);
    const off = onHostFiguresDemandChange(heard);

    setHostFiguresFollowed(1, true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);

    off();
    setHostFiguresFollowed(1, false);
    expect(heard).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
