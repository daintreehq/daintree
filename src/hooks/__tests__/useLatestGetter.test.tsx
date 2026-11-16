// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestGetter } from "../useLatestGetter";

describe("useLatestGetter", () => {
  it("returns the value of the latest committed render", () => {
    const { result, rerender } = renderHook(({ value }) => useLatestGetter(value), {
      initialProps: { value: "a" },
    });
    expect(result.current()).toBe("a");
    rerender({ value: "b" });
    expect(result.current()).toBe("b");
  });

  it("keeps one getter identity across renders", () => {
    const { result, rerender } = renderHook(({ value }) => useLatestGetter(value), {
      initialProps: { value: 1 },
    });
    const first = result.current;
    rerender({ value: 2 });
    expect(result.current).toBe(first);
    expect(first()).toBe(2);
  });
});
