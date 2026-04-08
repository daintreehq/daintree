// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useProjectSwitchRehydration } from "../useProjectSwitchRehydration";

describe("useProjectSwitchRehydration", () => {
  it("is a no-op function (per-project WebContentsViews handle hydration independently)", () => {
    const { result } = renderHook(() => useProjectSwitchRehydration());
    expect(result.current).toBeUndefined();
  });

  it("can be called multiple times without error", () => {
    const { result, rerender } = renderHook(() => useProjectSwitchRehydration());
    rerender();
    rerender();
    expect(result.current).toBeUndefined();
  });
});
