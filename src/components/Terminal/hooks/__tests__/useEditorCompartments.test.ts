// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import { useEditorCompartments } from "../useEditorCompartments";

describe("useEditorCompartments", () => {
  it("returns 14 distinct compartment refs", () => {
    const { result } = renderHook(() => useEditorCompartments());
    const keys = Object.keys(result.current);
    expect(keys).toHaveLength(14);
    const compartments = keys.map(
      (key) => result.current[key as keyof typeof result.current].current
    );
    for (const compartment of compartments) expect(compartment).toBeInstanceOf(Compartment);
    // A reconfigure on a shared compartment would swap out the other extension too.
    expect(new Set(compartments).size).toBe(compartments.length);
  });

  it("maintains stable identity across rerenders", () => {
    const { result, rerender } = renderHook(() => useEditorCompartments());
    const first = result.current.keymapCompartmentRef.current;
    rerender();
    expect(result.current.keymapCompartmentRef.current).toBe(first);
  });
});
