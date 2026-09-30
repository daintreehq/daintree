// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { compareTreeNames } from "@/components/PluginKit/PluginKitFileTree";
import { FLEX_COLUMN_MAX_PX, layoutColumns } from "@/components/PluginKit/PluginKitLists";
import { sparklineRuns } from "@/components/PluginKit/PluginKitData";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function inViewport(children: ReactNode, viewportHeight = 240) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight, itemHeight: 24 } },
    children
  );
}

function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="treeitem"]')].map(
    (row) => row.getAttribute("aria-label") ?? ""
  );
}

describe("@daintreehq/plugin-ui file trees, stat cards, sparklines and field groups", () => {
  it("reports version 1.0.0", () => {
    expect(kit.PLUGIN_UI_VERSION).toBe("1.0.0");
  });
});

describe("FileTree", () => {
  it("orders folders first, then numeric-aware and case-insensitive names", () => {
    const names = ["churn-10.txt", "churn-2.txt", "README.md", "alpha.ts", "Beta.ts"];
    const sorted = names
      .map((name) => ({ name, isDirectory: false }))
      .concat([{ name: "src", isDirectory: true }])
      .sort(compareTreeNames)
      .map((entry) => entry.name);
    expect(sorted).toEqual([
      "src",
      "alpha.ts",
      "Beta.ts",
      "churn-2.txt",
      "churn-10.txt",
      "README.md",
    ]);
  });

  it("builds the tree from a walk-shaped flat list and fills in missing folders", () => {
    const { container } = render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          entries: [
            { path: "churn-10.txt", type: "file" },
            { path: "churn-2.txt", type: "file" },
            { path: "src/deep/index.ts", type: "file" },
            { path: "docs", type: "dir" },
          ],
          defaultExpandedPaths: ["src"],
        })
      )
    );
    expect(rowNames(container)).toEqual(["docs", "src", "deep", "churn-2.txt", "churn-10.txt"]);
    const src = screen.getByRole("treeitem", { name: "src" });
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(src.getAttribute("aria-level")).toBe("1");
    expect(screen.getByRole("treeitem", { name: "deep" }).getAttribute("aria-level")).toBe("2");
    expect(
      screen.getByRole("treeitem", { name: "churn-2.txt" }).getAttribute("aria-posinset")
    ).toBe("3");
  });

  it("keeps the input order with sort='none'", () => {
    const { container } = render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          sort: "none",
          entries: [
            { path: "b.txt", type: "file" },
            { path: "a.txt", type: "file" },
          ],
        })
      )
    );
    expect(rowNames(container)).toEqual(["b.txt", "a.txt"]);
  });

  it("gives files the chevron gutter so their icons line up with folders'", () => {
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }, { name: "b.ts" }],
        })
      )
    );
    const file = screen.getByRole("treeitem", { name: "b.ts" });
    expect(file.firstElementChild?.hasAttribute("data-file-tree-gutter")).toBe(true);
    const folder = screen.getByRole("treeitem", { name: "src" });
    expect(folder.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(folder.firstElementChild?.className).toContain("w-4");
  });

  it("drops the gutter when there are no folders at all", () => {
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          entries: [{ path: "a.ts", type: "file" }],
        })
      )
    );
    const file = screen.getByRole("treeitem", { name: "a.ts" });
    expect(file.querySelector("[data-file-tree-gutter]")).toBeNull();
  });

  it("drives selection and expansion from the keyboard", () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [
            { name: "src", children: [{ name: "a.ts" }, { name: "b.ts" }] },
            { name: "zeta.md" },
          ],
          onSelect,
          onActivate,
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("src", {
      path: "src",
      name: "src",
      type: "directory",
      depth: 0,
    });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("src/a.ts", expect.objectContaining({ depth: 1 }));
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("src", expect.anything());
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(screen.queryByRole("treeitem", { name: "a.ts" })).toBeNull();
    fireEvent.keyDown(tree, { key: "z" });
    expect(onSelect).toHaveBeenLastCalledWith("zeta.md", expect.anything());
    expect(screen.getByRole("treeitem", { name: "zeta.md" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("zeta.md", expect.objectContaining({ type: "file" }));
    fireEvent.keyDown(tree, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("src", expect.anything());
  });

  it("toggles from the chevron without moving the selection", () => {
    const onSelect = vi.fn();
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }],
          onSelect,
        })
      )
    );
    const folder = screen.getByRole("treeitem", { name: "src" });
    const chevron = folder.firstElementChild;
    if (!chevron) throw new Error("no chevron");
    fireEvent.click(chevron);
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("treeitem", { name: "a.ts" }));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts", expect.anything());
  });

  it("follows controlled selection and expansion", () => {
    function Controlled() {
      const [expanded, setExpanded] = useState<string[]>([]);
      return inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }],
          selectedPath: "src",
          expandedPaths: expanded,
          onExpandedPathsChange: setExpanded,
        })
      );
    }
    render(createElement(Controlled));
    const tree = screen.getByRole("tree");
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "a.ts" })).not.toBeNull();
    // Selection is controlled and never changed, so the cursor stays put.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("mounts a bounded window of a 10k-file tree in natural order", () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => ({
      path: `file-${9_999 - i}.txt`,
      type: "file" as const,
    }));
    const { container } = render(
      inViewport(createElement(kit.FileTree, { "aria-label": "Files", entries }))
    );
    const rows = rowNames(container);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows.slice(0, 3)).toEqual(["file-0.txt", "file-1.txt", "file-2.txt"]);
    expect(container.querySelectorAll("*").length).toBeLessThan(1500);
  });

  it("shows `empty` when there is nothing to list", () => {
    render(
      createElement(kit.FileTree, {
        "aria-label": "Files",
        entries: [],
        empty: createElement("p", null, "No files"),
      })
    );
    expect(screen.getByText("No files")).not.toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });
});

describe("StatCard and Sparkline", () => {
  it("draws a sentence-case label, the figure and a signed delta without accent", () => {
    const { container } = render(
      createElement(kit.StatCard, {
        label: "Changed files",
        value: "43",
        delta: -2,
        hint: "2 worktrees",
        "data-testid": "stat",
      })
    );
    const card = screen.getByTestId("stat");
    expect(card.textContent).toContain("Changed files");
    expect(card.textContent).toContain("43");
    expect(card.textContent).toContain("−2");
    expect(card.textContent).toContain("2 worktrees");
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-|accent/);
  });

  it("marks a toned stat with its severity glyph and word", () => {
    render(createElement(kit.StatCard, { label: "Errors", value: 3, tone: "error" }));
    expect(screen.getByText("Error:", { exact: false }).className).toContain("sr-only");
    expect(document.querySelector('svg[class*="text-status-"]')).not.toBeNull();
  });

  it("scales a sparkline into its box, splitting at gaps", () => {
    const runs = sparklineRuns([0, 10, Number.NaN, 5, 5], 24);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(2);
    // The floor and ceiling stay inside the dot's inset.
    expect(runs[0]?.[0]).toBe("0.00,22.00");
    expect(runs[0]?.[1]).toBe("25.00,2.00");
    expect(sparklineRuns([7], 24)).toEqual([]);
  });

  it("draws the newest-value dot only when the final sample is present", () => {
    const { container } = render(
      createElement(kit.Sparkline, { values: [1, 2, Number.NaN], "aria-label": "Gap" })
    );
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(container.querySelector("[data-sparkline-dot]")).toBeNull();
    cleanup();
    const { container: present } = render(
      createElement(kit.Sparkline, { values: [1, Number.NaN, 2, 3], "aria-label": "Recovered" })
    );
    expect(present.querySelector("[data-sparkline-dot]")).not.toBeNull();
  });

  it("renders a labelled SVG trend in a theme colour, never accent", () => {
    const { container } = render(
      createElement(kit.Sparkline, { values: [1, 3, 2], "aria-label": "Events", height: 32 })
    );
    const svg = screen.getByRole("img", { name: "Events" });
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("class")).toContain("text-text-secondary");
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(container.querySelector("[data-sparkline-dot]")).not.toBeNull();
    cleanup();
    const { container: toned } = render(
      createElement(kit.Sparkline, { values: [1, 2], "aria-label": "", tone: "warning" })
    );
    const hidden = toned.querySelector("svg");
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    expect(hidden?.getAttribute("class")).toContain("text-status-warning");
  });
});

describe("kit polish", () => {
  it("centres a switch on its label line in a horizontal FormField", () => {
    const { container } = render(
      createElement(kit.FormField, {
        label: "Notify me",
        orientation: "horizontal",
        children: createElement(kit.Switch, { checked: true }),
      })
    );
    const row = container.querySelector("label");
    expect(row?.className).toContain(
      "[&>[data-field-control][data-slot=switch][data-size=md]]:-mt-0.5"
    );
    expect(row?.querySelector(":scope > [role=switch]")).not.toBeNull();
  });

  it("labels a group of controls at a field label's size", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(kit.FormField, { label: "Title", children: createElement(kit.Input, {}) }),
        createElement(
          kit.FormFieldGroup,
          { label: "Labels", required: true, description: "Pick any", layout: "inline" },
          createElement(kit.FormField, {
            label: "bug",
            orientation: "horizontal",
            children: createElement(kit.Checkbox, {}),
          })
        )
      )
    );
    const group = screen.getByRole("group", { name: "Labels" });
    expect(group.tagName).toBe("FIELDSET");
    const described = (group.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Required", "Pick any"]);
    const fieldLabel = container.querySelector("label[for]");
    const groupLabel = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    const sizeOf = (el: Element | null | undefined) =>
      (el?.className ?? "").split(" ").filter((c) => /^text-(xs|sm|base)$/.test(c));
    expect(sizeOf(groupLabel)).toEqual(sizeOf(fieldLabel));
    expect(screen.getByRole("checkbox", { name: "bug" })).not.toBeNull();
  });

  it("disables every control in a disabled group", () => {
    render(
      createElement(
        kit.FormFieldGroup,
        { label: "Labels", disabled: true },
        createElement(kit.Checkbox, { "aria-label": "bug" })
      )
    );
    expect((screen.getByRole("group") as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("sets code in a ListRow title at the host's mono size", () => {
    const { container } = render(
      createElement(kit.ListRow, { title: createElement("code", null, "read_file") })
    );
    const title = container.querySelector("code")?.parentElement;
    expect(title?.className).toContain("[&_code]:text-xs");
  });

  it("fills and centres a canvas EmptyState in its container", () => {
    const { container } = render(createElement(kit.EmptyState, { title: "Select a note" }));
    const root = container.querySelector("[role=status], div");
    expect(root?.className).toMatch(/\bflex-1\b/);
    expect(root?.className).toMatch(/\bh-full\b/);
    cleanup();
    const { container: narrow } = render(
      createElement(kit.EmptyState, { title: "None", scale: "sidebar" })
    );
    expect(narrow.querySelector("div")?.className).not.toMatch(/\bflex-1\b/);
  });

  it("caps unsized DataTable columns and keeps sized ones exact", () => {
    const sized = [
      { width: 64, grow: false },
      { width: undefined, grow: false },
      { width: 112, grow: false },
    ];
    expect(layoutColumns(sized, 1560)).toEqual({
      widths: [64, FLEX_COLUMN_MAX_PX, 112],
      filler: true,
    });
    // Narrow enough that the share is under the cap: the plain share, no filler.
    expect(layoutColumns(sized, 500)).toEqual({ widths: [64, undefined, 112], filler: false });
    // Every column sized: exactly those widths, the rest left as trailing space.
    expect(layoutColumns([{ width: 80, grow: false }], 1000).filler).toBe(true);
    // `grow` opts one column into everything left.
    expect(
      layoutColumns(
        [
          { width: 64, grow: false },
          { width: undefined, grow: true },
        ],
        1560
      )
    ).toEqual({ widths: [64, undefined], filler: false });
    // Unmeasured: the fixed-layout share.
    expect(layoutColumns(sized, null).filler).toBe(false);
    // A px string sums like a number; a relative length cannot be summed.
    const pxString = [
      { width: "120px", grow: false },
      { width: undefined, grow: false },
    ];
    expect(layoutColumns(pxString, 1560)).toEqual({
      widths: ["120px", FLEX_COLUMN_MAX_PX],
      filler: true,
    });
    expect(
      layoutColumns(
        [
          { width: "20%", grow: false },
          { width: undefined, grow: false },
        ],
        1560
      ).filler
    ).toBe(false);
    // `grow` on a sized column has nothing to take, so the cap still applies.
    expect(
      layoutColumns(
        [
          { width: 64, grow: true },
          { width: undefined, grow: false },
        ],
        1560
      ).filler
    ).toBe(true);
  });

  it("draws the DataTable filler as an unlabelled trailing cell", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<{ id: string }>, {
          "aria-label": "Ids",
          rows: [{ id: "a" }],
          rowKey: "id",
          columns: [{ id: "id", header: "Id", width: 80 }],
        })
      )
    );
    const headers = container.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    expect(headers[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(container.querySelector("tbody td[aria-hidden=true]")).not.toBeNull();
  });

  it("aligns Markdown to the leading edge on request", async () => {
    const { container } = render(
      createElement(kit.Markdown, { source: "Hello", align: "start", className: "px-3" })
    );
    await vi.waitFor(() => {
      if (!container.querySelector(".markdown-document")) throw new Error("not rendered");
    });
    const doc = container.querySelector(".markdown-document");
    expect(doc?.className).toContain("mx-0!");
    expect(doc?.className).toContain("px-3");
    cleanup();
    const { container: centred } = render(createElement(kit.Markdown, { source: "Hello" }));
    await vi.waitFor(() => {
      if (!centred.querySelector(".markdown-document")) throw new Error("not rendered");
    });
    expect(centred.querySelector(".markdown-document")?.className).not.toContain("mx-0!");
  });
});
