// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import { useEditorCompartments } from "../useEditorCompartments";

describe("useEditorCompartments", () => {
  it("keeps independent compartments stable across rerenders", () => {
    const { result, rerender } = renderHook(() => useEditorCompartments());
    const compartments = Object.values(result.current).map((ref) => ref.current);

    // Sharing a compartment lets one reconfiguration replace a different extension.
    expect(compartments.length).toBeGreaterThan(0);
    expect(new Set(compartments).size).toBe(compartments.length);
    for (const compartment of compartments) expect(compartment).toBeInstanceOf(Compartment);

    rerender();

    const next = Object.values(result.current).map((ref) => ref.current);
    expect(next).toHaveLength(compartments.length);
    next.forEach((compartment, index) => expect(compartment).toBe(compartments[index]));
  });
});
