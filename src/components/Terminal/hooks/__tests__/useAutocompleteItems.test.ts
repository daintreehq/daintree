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

  it("splits file paths into basename label and directory description", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "file",
        autocompleteFiles: ["src/components/Button.tsx", "README.md"],
      })
    );
    const [nested, root] = result.current.autocompleteItems;
    expect(nested!.label).toBe("Button.tsx");
    expect(nested!.description).toBe("src/components");
    expect(nested!.insertText).toBe("src/components/Button.tsx");
    expect(root!.label).toBe("README.md");
    expect(root!.description).toBeUndefined();
    expect(root!.insertText).toBe("README.md");
  });

  it("disambiguates duplicate basenames via directory descriptions", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "file",
        autocompleteFiles: ["src/a/index.ts", "src/b/index.ts"],
      })
    );
    const items = result.current.autocompleteItems;
    expect(items[0]!.label).toBe("index.ts");
    expect(items[1]!.label).toBe("index.ts");
    expect(items[0]!.description).toBe("src/a");
    expect(items[1]!.description).toBe("src/b");
    expect(items[0]!.key).not.toBe(items[1]!.key);
  });

  it("handles Windows separators and trailing-separator paths", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeMode: "file",
        autocompleteFiles: ["src\\utils\\log.ts", "src/dir/"],
      })
    );
    const [win, trailing] = result.current.autocompleteItems;
    expect(win!.label).toBe("log.ts");
    expect(win!.description).toBe("src\\utils");
    // Trailing separator yields an empty basename — falls back to the full path.
    expect(trailing!.label).toBe("src/dir/");
    expect(trailing!.insertText).toBe("src/dir/");
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
      { key: "/help", label: "/help", insertText: "/help" },
      { key: "/clear", label: "/clear", insertText: "/clear" },
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
