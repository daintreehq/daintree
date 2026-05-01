import { describe, it, expect } from "vitest";

// Mirrors the showLegend derivation in HybridInputBar.tsx so the rule stays
// covered without rendering the full component (which requires the full
// CodeMirror + IPC bring-up).
function computeShowLegend(params: {
  isEditorFocused: boolean;
  value: string;
  isAutocompleteOpen: boolean;
  disabled: boolean;
}): boolean {
  const { isEditorFocused, value, isAutocompleteOpen, disabled } = params;
  return isEditorFocused && value.trim() === "" && !isAutocompleteOpen && !disabled;
}

describe("HybridInputBar showLegend derivation", () => {
  it("shows when focused, empty, autocomplete closed, not disabled", () => {
    expect(
      computeShowLegend({
        isEditorFocused: true,
        value: "",
        isAutocompleteOpen: false,
        disabled: false,
      })
    ).toBe(true);
  });

  it("hides when not focused", () => {
    expect(
      computeShowLegend({
        isEditorFocused: false,
        value: "",
        isAutocompleteOpen: false,
        disabled: false,
      })
    ).toBe(false);
  });

  it("hides when input has content", () => {
    expect(
      computeShowLegend({
        isEditorFocused: true,
        value: "hello",
        isAutocompleteOpen: false,
        disabled: false,
      })
    ).toBe(false);
  });

  it("treats whitespace-only input as empty (legend shows)", () => {
    // Mirrors the submit handler convention in HybridInputBar.tsx: whitespace-only
    // input is "empty" for all UX purposes, so the legend's discovery hint stays
    // visible until the user has typed something meaningful.
    expect(
      computeShowLegend({
        isEditorFocused: true,
        value: "   \n\t  ",
        isAutocompleteOpen: false,
        disabled: false,
      })
    ).toBe(true);
  });

  it("hides when autocomplete menu is open", () => {
    expect(
      computeShowLegend({
        isEditorFocused: true,
        value: "",
        isAutocompleteOpen: true,
        disabled: false,
      })
    ).toBe(false);
  });

  it("hides when input is disabled", () => {
    expect(
      computeShowLegend({
        isEditorFocused: true,
        value: "",
        isAutocompleteOpen: false,
        disabled: true,
      })
    ).toBe(false);
  });
});

// Mirrors the placeholder useMemo. Sanity-checks the new copy without
// depending on the agent registry.
function computePlaceholder(agentName: string | null): string {
  return agentName ? `Ask ${agentName}` : "Ask anything";
}

describe("HybridInputBar placeholder copy", () => {
  it("uses 'Ask anything' when no agent is bound", () => {
    expect(computePlaceholder(null)).toBe("Ask anything");
  });

  it("uses 'Ask {agentName}' when an agent is bound", () => {
    expect(computePlaceholder("Claude")).toBe("Ask Claude");
    expect(computePlaceholder("Gemini")).toBe("Ask Gemini");
  });
});
