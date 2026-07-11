// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutocompleteItems } from "../useAutocompleteItems";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import type { CompletionTrigger } from "@shared/types";

function atContext(query: string): ActiveCompletionContext {
  return { triggerChar: "@", start: 0, tokenEnd: query.length + 1, query };
}

const baseParams = {
  activeCompletionContext: null as ActiveCompletionContext | null,
  autocompleteFiles: [] as string[],
  isAutocompleteLoading: false,
  autocompleteCommands: [] as AutocompleteItem[],
  isCommandsLoading: false,
};

describe("useAutocompleteItems", () => {
  it("returns empty items when there is no active context", () => {
    const { result } = renderHook(() => useAutocompleteItems(baseParams));
    expect(result.current.autocompleteItems).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns file items when @ query claims no Daintree provider", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("src/"),
        autocompleteFiles: ["src/index.ts", "src/app.ts"],
        isAutocompleteLoading: true,
      })
    );
    expect(result.current.autocompleteItems).toHaveLength(2);
    expect(result.current.autocompleteItems[0]!.key).toBe("src/index.ts");
    expect(result.current.autocompleteItems[0]!.enterAction).toBe("insert");
    expect(result.current.isLoading).toBe(true);
  });

  it("splits file paths into basename label and directory description", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("src/"),
        autocompleteFiles: ["src/components/Button.tsx", "README.md"],
      })
    );
    const [nested, root] = result.current.autocompleteItems;
    expect(nested!.label).toBe("Button.tsx");
    expect(nested!.description).toBe("src/components");
    // insertText is the canonical @token (formatted at construction).
    expect(nested!.insertText).toBe("@src/components/Button.tsx");
    expect(root!.label).toBe("README.md");
    expect(root!.description).toBeUndefined();
    expect(root!.insertText).toBe("@README.md");
  });

  it("splits Windows-separator paths and keeps a canonical @token", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("src"),
        autocompleteFiles: ["src\\utils\\log.ts", "src/dir/"],
      })
    );
    const [win, trailing] = result.current.autocompleteItems;
    expect(win!.label).toBe("log.ts");
    expect(win!.description).toBe("src\\utils");
    // Key stays the raw path (for staleness); insertText is the canonical @token.
    expect(win!.key).toBe("src\\utils\\log.ts");
    expect(win!.insertText).toBe("@src\\utils\\log.ts");
    // Trailing separator → empty basename → falls back to the full path.
    expect(trailing!.label).toBe("src/dir/");
    expect(trailing!.insertText).toBe("@src/dir/");
  });

  it("quotes file insert text when the path contains spaces", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("My"),
        autocompleteFiles: ["My Folder/a b.txt"],
      })
    );
    expect(result.current.autocompleteItems[0]!.insertText).toBe('@"My Folder/a b.txt"');
    expect(result.current.autocompleteItems[0]!.key).toBe("My Folder/a b.txt");
  });

  it("routes a bare @ to diff items only — file results never leak in", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext(""),
        autocompleteFiles: ["a.ts", "b.ts"],
      })
    );
    const items = result.current.autocompleteItems;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.key.startsWith("diff"))).toBe(true);
  });

  it("filters diff items by partial and carries the diff resolver + insert action", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({ ...baseParams, activeCompletionContext: atContext("diff:s") })
    );
    const items = result.current.autocompleteItems;
    expect(items.some((i) => i.key === "diff:staged")).toBe(true);
    expect(items.every((i) => i.key.startsWith("diff:s"))).toBe(true);
    expect(items[0]!.enterAction).toBe("insert");
    expect(items[0]!.insert).toEqual({ insert: "resolve", resolverId: "diff" });
  });

  it("returns the terminal item when @ query claims terminal", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({ ...baseParams, activeCompletionContext: atContext("term") })
    );
    expect(result.current.autocompleteItems).toHaveLength(1);
    expect(result.current.autocompleteItems[0]!.key).toBe("terminal");
    expect(result.current.autocompleteItems[0]!.insert).toEqual({
      insert: "resolve",
      resolverId: "terminal",
    });
  });

  it("returns the selection item when @ query claims selection", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({ ...baseParams, activeCompletionContext: atContext("sele") })
    );
    expect(result.current.autocompleteItems).toHaveLength(1);
    expect(result.current.autocompleteItems[0]!.key).toBe("selection");
  });

  it.each([["/"], ["$"]] as [CompletionTrigger][])(
    "passes through pre-mapped %s items verbatim (same array, loading state)",
    (trigger) => {
      const commands: AutocompleteItem[] = [
        {
          key: "x",
          label: `${trigger}x`,
          insertText: `${trigger}x`,
          enterAction: trigger === "/" ? "execute" : "insert",
          insert: "literal",
        },
      ];
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: { triggerChar: trigger, start: 0, tokenEnd: 2, query: "x" },
          autocompleteCommands: commands,
          isCommandsLoading: true,
        })
      );
      // Identity: the discovery items pass straight through, unmodified.
      expect(result.current.autocompleteItems).toBe(commands);
      expect(result.current.isLoading).toBe(true);
    }
  );
});
