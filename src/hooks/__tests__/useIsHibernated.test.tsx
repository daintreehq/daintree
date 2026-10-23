// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const loadMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/TerminalInstanceService", () => {
  loadMock();
  return { terminalInstanceService: {} };
});

import { useIsHibernated } from "../useIsHibernated";

describe("useIsHibernated", () => {
  it("is false for every id without loading the terminal service", () => {
    const { result, rerender } = renderHook(({ id }) => useIsHibernated(id), {
      initialProps: { id: "t1" },
    });
    expect(result.current).toBe(false);

    rerender({ id: "t2" });
    expect(result.current).toBe(false);
    expect(loadMock).not.toHaveBeenCalled();
  });
});
