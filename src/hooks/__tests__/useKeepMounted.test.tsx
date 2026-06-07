// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeepMounted } from "../useKeepMounted";

describe("useKeepMounted", () => {
  it("starts unmounted when never opened", () => {
    const { result } = renderHook(({ isOpen }) => useKeepMounted(isOpen), {
      initialProps: { isOpen: false },
    });
    expect(result.current).toBe(false);
  });

  it("mounts while open", () => {
    const { result } = renderHook(({ isOpen }) => useKeepMounted(isOpen), {
      initialProps: { isOpen: true },
    });
    expect(result.current).toBe(true);
  });

  it("stays mounted after closing so the exit animation can run", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useKeepMounted(isOpen), {
      initialProps: { isOpen: false },
    });
    expect(result.current).toBe(false);

    rerender({ isOpen: true });
    expect(result.current).toBe(true);

    // The whole point: closing must NOT collapse the mount in the same render.
    rerender({ isOpen: false });
    expect(result.current).toBe(true);
  });

  it("remains mounted across repeated open/close cycles", () => {
    const { result, rerender } = renderHook(({ isOpen }) => useKeepMounted(isOpen), {
      initialProps: { isOpen: true },
    });

    for (let cycle = 0; cycle < 3; cycle++) {
      rerender({ isOpen: false });
      expect(result.current).toBe(true);
      rerender({ isOpen: true });
      expect(result.current).toBe(true);
    }
  });
});
