// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutocompleteItems } from "../useAutocompleteItems";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import type { CompletionTrigger } from "@shared/types";
import type { ForgeReference } from "../../forgeReferences";

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
    // A directory is named by its last segment, separator kept, under its
    // parent, rather than repeating its own path as its description.
    expect(trailing!.label).toBe("dir/");
    expect(trailing!.description).toBe("src");
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

  describe("prompt templates", () => {
    const command: AutocompleteItem = {
      key: "x",
      label: "/x",
      insertText: "/x",
      enterAction: "execute",
      insert: "literal",
    };
    const template: AutocompleteItem = {
      key: "template:acme::x",
      label: "Add boilerplate",
      insertText: "",
      group: "Prompt templates",
      template: { key: "acme::x", opensForm: false },
    };

    it("lists them after the agent's commands in a `/` menu", () => {
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: { triggerChar: "/", start: 0, tokenEnd: 2, query: "x" },
          autocompleteCommands: [command],
          isCommandsLoading: true,
          templateItems: [template],
        })
      );
      expect(result.current.autocompleteItems).toEqual([command, template]);
      expect(result.current.isLoading).toBe(true);
    });

    it.each([["$"], ["@"], ["#"], [null]] as const)("keeps them out of the %s menu", (trigger) => {
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext:
            trigger === null ? null : { triggerChar: trigger, start: 0, tokenEnd: 2, query: "x" },
          autocompleteCommands: [command],
          autocompleteFiles: ["x.ts"],
          templateItems: [template],
        })
      );
      expect(result.current.autocompleteItems.some((item) => item.template)).toBe(false);
    });
  });

  describe("`#` references", () => {
    function hashContext(query: string): ActiveCompletionContext {
      return { triggerChar: "#", start: 0, tokenEnd: query.length + 1, query };
    }
    const refs: ForgeReference[] = [
      {
        kind: "issue",
        number: 14848,
        reference: "#14848",
        title: "Suggest issues when typing #",
        isDraft: false,
        updatedAt: 3,
      },
      {
        kind: "pr",
        number: 14843,
        reference: "!14843",
        title: "Clean up long dictations",
        isDraft: true,
        updatedAt: 2,
      },
      {
        kind: "pr",
        number: 9001,
        reference: "!9001",
        title: "Toolbar counts",
        isDraft: false,
        updatedAt: 1,
      },
    ];

    it("shows each row's reference, kind and state, and title, inserting the reference", () => {
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: hashContext(""),
          forgeReferences: refs,
        })
      );
      expect(
        result.current.autocompleteItems.map((row) => [
          row.label,
          row.badge,
          row.description,
          row.insertText,
        ])
      ).toEqual([
        ["#14848", "Open issue", "Suggest issues when typing #", "#14848"],
        ["!14843", "Draft PR", "Clean up long dictations", "!14843"],
        ["!9001", "Open PR", "Toolbar counts", "!9001"],
      ]);
      expect(new Set(result.current.autocompleteItems.map((row) => row.insert))).toEqual(
        new Set(["literal"])
      );
      expect(result.current.isLoading).toBe(false);
    });

    it("narrows by the typed query", () => {
      const byNumber = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: hashContext("148"),
          forgeReferences: refs,
        })
      );
      expect(byNumber.result.current.autocompleteItems.map((row) => row.label)).toEqual([
        "#14848",
        "!14843",
      ]);
      const byTitle = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: hashContext("tool"),
          forgeReferences: refs,
        })
      );
      expect(byTitle.result.current.autocompleteItems.map((row) => row.label)).toEqual(["!9001"]);
    });

    it("gives an issue and a pull request with the same number their own rows", () => {
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: hashContext("5"),
          forgeReferences: [
            { ...refs[0]!, number: 5, reference: "#5" },
            { ...refs[1]!, number: 5, reference: "!5" },
          ],
        })
      );
      const keys = result.current.autocompleteItems.map((row) => row.key);
      expect(new Set(keys).size).toBe(2);
    });

    it("offers no rows to other triggers", () => {
      const { result } = renderHook(() =>
        useAutocompleteItems({
          ...baseParams,
          activeCompletionContext: atContext("src"),
          forgeReferences: refs,
        })
      );
      expect(result.current.autocompleteItems).toEqual([]);
    });
  });
});
