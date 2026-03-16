import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import { useEditorCompartments } from "../useEditorCompartments";

describe("useEditorCompartments", () => {
  it("returns 12 compartment refs", () => {
    const { result } = renderHook(() => useEditorCompartments());
    const keys = Object.keys(result.current);
    expect(keys).toHaveLength(12);
    for (const key of keys) {
      const ref = result.current[key as keyof typeof result.current];
      expect(ref.current).toBeInstanceOf(Compartment);
    }
  });

  it("maintains stable identity across rerenders", () => {
    const { result, rerender } = renderHook(() => useEditorCompartments());
    const first = result.current.keymapCompartmentRef.current;
    rerender();
    expect(result.current.keymapCompartmentRef.current).toBe(first);
  });
});
