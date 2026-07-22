// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { FileTreeView } from "../FileTreeView";
import type { FlatTreeRow } from "../fileBrowserTree";

// Render every row: the virtualization itself is not under test, and the row
// interactions below need real DOM nodes for every item.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function VirtuosoStub(
    props: {
      data: FlatTreeRow[];
      context: unknown;
      itemContent: (index: number, row: FlatTreeRow, context: unknown) => ReactNode;
    },
    _ref
  ) {
    return (
      <div>
        {props.data.map((row, index) => (
          <div key={row.path}>{props.itemContent(index, row, props.context)}</div>
        ))}
      </div>
    );
  }),
}));

function row(path: string, isDirectory = false): FlatTreeRow {
  return {
    path,
    name: path.split("/").pop()!,
    isDirectory,
    depth: 0,
    isExpanded: false,
    isLoading: false,
    isIgnored: false,
  };
}

const ROWS = [row("src", true), row("README.md")];

function renderTree(overrides: Partial<Parameters<typeof FileTreeView>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <FileTreeView
      rows={ROWS}
      selectedPath={null}
      onSelect={onSelect}
      onToggleExpanded={vi.fn()}
      rowContextMenu={() => <div />}
      label="Files"
      {...overrides}
    />
  );
  return { onSelect, ...utils };
}

describe("FileTreeView context-menu interactions", () => {
  it("selects a row on right-click so the menu visibly targets it", () => {
    const { onSelect, getByRole } = renderTree();

    fireEvent.contextMenu(getByRole("treeitem", { name: "src" }));

    expect(onSelect).toHaveBeenCalledWith("src");
  });

  it("replays the ContextMenu key as a contextmenu event on the selected row", () => {
    const { getByRole } = renderTree({ selectedPath: "README.md" });
    const contextMenuSpy = vi.fn();
    getByRole("treeitem", { name: "README.md" }).addEventListener("contextmenu", contextMenuSpy);

    const notPrevented = fireEvent.keyDown(getByRole("tree"), { key: "ContextMenu" });

    expect(contextMenuSpy).toHaveBeenCalledTimes(1);
    // preventDefault must fire so the browser's own contextmenu for the
    // keypress cannot double-open the menu.
    expect(notPrevented).toBe(false);
  });

  it("replays Shift+F10 but leaves plain F10 alone", () => {
    const { getByRole } = renderTree({ selectedPath: "src" });
    const contextMenuSpy = vi.fn();
    getByRole("treeitem", { name: "src" }).addEventListener("contextmenu", contextMenuSpy);

    // Queried once up front: the first keypress opens a real Radix menu,
    // which aria-hides everything outside it — a second role query would
    // no longer find the tree.
    const tree = getByRole("tree");
    fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
    fireEvent.keyDown(tree, { key: "F10" });

    expect(contextMenuSpy).toHaveBeenCalledTimes(1);
  });

  it("advertises data-row-menu only when rows actually have menus", () => {
    // The attribute is the contract with the global Shift+F10 handler: it
    // stands down inside surfaces that route the key to a row-level menu, so
    // advertising it without a menu would swallow the panel-level fallback.
    const withMenu = renderTree();
    expect(withMenu.getByRole("tree").hasAttribute("data-row-menu")).toBe(true);
    withMenu.unmount();

    const { getByRole } = render(
      <FileTreeView
        rows={ROWS}
        selectedPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        label="Files"
      />
    );
    expect(getByRole("tree").hasAttribute("data-row-menu")).toBe(false);
  });
});
