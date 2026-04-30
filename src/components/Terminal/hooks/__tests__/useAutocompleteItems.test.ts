// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutocompleteItems } from "../useAutocompleteItems";

const baseParams = {
  activeMode: null as "command" | "file" | "diff" | "terminal" | "selection" | null,
  diffContext: null,
  terminalContext: null,
  selectionContext: null,
  value: "",
  autocompleteFiles: [] as string[],
  isAutocompleteLoading: false,
  autocompleteCommands: [],
  isCommandsLoading: false,
};

describe("useAutocompleteItems", () => {
  it("returns empty items when activeMode is null", () => {
    const { result } = renderHook(() => useAutocompleteItems(baseParams));
    expect(result.current.autocompleteItems).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns file items when activeMode is file", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "file",
        autocompleteFiles: ["src/index.ts", "src/app.ts"],
        isAutocompleteLoading: true,
      })
    );
    expect(result.current.autocompleteItems).toHaveLength(2);
    expect(result.current.autocompleteItems[0]!.key).toBe("src/index.ts");
    expect(result.current.isLoading).toBe(true);
  });

  it("returns diff items filtered by partial", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "diff",
        diffContext: { atStart: 0, tokenEnd: 6, diffType: "staged" as const },
        value: "@diff:s",
      })
    );
    expect(result.current.autocompleteItems.length).toBeGreaterThanOrEqual(1);
    expect(result.current.autocompleteItems.some((i) => i.key === "diff:staged")).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns terminal item when activeMode is terminal", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "terminal",
        terminalContext: { atStart: 0, tokenEnd: 9 },
      })
    );
    expect(result.current.autocompleteItems).toHaveLength(1);
    expect(result.current.autocompleteItems[0]!.key).toBe("terminal");
  });

  it("returns selection item when activeMode is selection", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "selection",
        selectionContext: { atStart: 0, tokenEnd: 10 },
      })
    );
    expect(result.current.autocompleteItems).toHaveLength(1);
    expect(result.current.autocompleteItems[0]!.key).toBe("selection");
  });

  it("returns command items when activeMode is command", () => {
    const commands = [
      { key: "/help", label: "/help", value: "/help" },
      { key: "/clear", label: "/clear", value: "/clear" },
    ];
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "command",
        autocompleteCommands: commands,
        isCommandsLoading: true,
      })
    );
    expect(result.current.autocompleteItems).toEqual(commands);
    expect(result.current.isLoading).toBe(true);
  });
});
