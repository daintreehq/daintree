// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutocompleteItems } from "../useAutocompleteItems";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import type { AutocompleteItem } from "../../AutocompleteMenu";

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
    expect(result.current.autocompleteItems[0]!.insert).toBe("literal");
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

  it("quotes file insert text when the path contains spaces", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("My"),
        autocompleteFiles: ["My Folder/a b.txt"],
      })
    );
    expect(result.current.autocompleteItems[0]!.insertText).toBe('@"My Folder/a b.txt"');
    // Key stays the raw path so per-item staleness can key off file paths.
    expect(result.current.autocompleteItems[0]!.key).toBe("My Folder/a b.txt");
  });

  it("returns diff items (resolve) filtered by partial when @ query claims diff", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: atContext("diff:s"),
      })
    );
    const items = result.current.autocompleteItems;
    expect(items.some((i) => i.key === "diff:staged")).toBe(true);
    expect(items.every((i) => i.key.startsWith("diff:s"))).toBe(true);
    expect(items[0]!.insert).toEqual({ insert: "resolve", resolverId: "diff" });
    expect(items[0]!.enterAction).toBe("insert");
    expect(result.current.isLoading).toBe(false);
  });

  it("returns all three diff items for a bare @", () => {
    const { result } = renderHook(() =>
      useAutocompleteItems({ ...baseParams, activeCompletionContext: atContext("") })
    );
    expect(result.current.autocompleteItems).toHaveLength(3);
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

  it("passes through command/capability items verbatim for / and $", () => {
    const commands: AutocompleteItem[] = [
      {
        key: "/help",
        label: "/help",
        insertText: "/help",
        enterAction: "execute",
        insert: "literal",
      },
    ];
    const { result } = renderHook(() =>
      useAutocompleteItems({
        ...baseParams,
        activeCompletionContext: { triggerChar: "/", start: 0, tokenEnd: 5, query: "h" },
        autocompleteCommands: commands,
        isCommandsLoading: true,
      })
    );
    expect(result.current.autocompleteItems).toEqual(commands);
    expect(result.current.isLoading).toBe(true);
  });
});
