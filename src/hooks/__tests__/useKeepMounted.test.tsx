// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeepMounted } from "../useKeepMounted";

describe("useKeepMounted", () => {
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
});
