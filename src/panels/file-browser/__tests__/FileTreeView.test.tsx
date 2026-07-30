// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { ContextMenuItem } from "@/components/ui/context-menu";
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
  it("opens the menu on the right-clicked row without moving the selection", async () => {
    // Right-click must not swap the viewed file: the menu targets the
    // right-clicked row directly (shown by that row's own open-state lift), so
    // moving the selection would pull the viewer off the file the user was
    // looking at mid-gesture. A row-specific menu item lets us prove the menu
    // opened on the row that was clicked, not merely that something opened.
    const onSelect = vi.fn();
    const { getByRole, findByRole } = render(
      <FileTreeView
        rows={ROWS}
        selectedPath="README.md"
        onSelect={onSelect}
        onToggleExpanded={vi.fn()}
        rowContextMenu={(clicked) => <ContextMenuItem>Act on {clicked.name}</ContextMenuItem>}
        label="Files"
      />
    );

    fireEvent.contextMenu(getByRole("treeitem", { name: "src" }));

    // The menu opens on the row that was right-clicked...
    expect(await findByRole("menuitem", { name: "Act on src" })).toBeTruthy();
    // ...while the previously selected row — and thus the viewer — stays put.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still selects a row on a plain click", () => {
    // Only right-click is decoupled from selection; the ordinary click path
    // must still drive it. A file row avoids coupling the assertion to the
    // directory-expansion toggle a folder click also fires.
    const { onSelect, getByRole } = renderTree();

    fireEvent.click(getByRole("treeitem", { name: "README.md" }));

    expect(onSelect).toHaveBeenCalledWith("README.md");
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

  it("routes double-click by row kind: folders re-root, files activate", () => {
    // Both callbacks supplied, so the assertion is that each row picks the right
    // one — not merely that the unwired branch does nothing (#11496).
    const onRootFolder = vi.fn();
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ onRootFolder, onActivate });

    fireEvent.doubleClick(getByRole("treeitem", { name: "src" }));
    expect(onRootFolder.mock.calls).toEqual([["src"]]);
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.doubleClick(getByRole("treeitem", { name: "README.md" }));
    expect(onActivate.mock.calls).toEqual([["README.md"]]);
    // The folder gesture never re-fires: a file double-click must not re-root.
    expect(onRootFolder.mock.calls).toEqual([["src"]]);
  });

  it("activates the selected row on Enter and consumes the key", () => {
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ selectedPath: "README.md", onActivate });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      getByRole("tree").dispatchEvent(event);
    });

    expect(onActivate.mock.calls).toEqual([["README.md"]]);
    // Handled keys are prevented so Enter doesn't also reach an outer surface.
    expect(event.defaultPrevented).toBe(true);
  });

  it("reports Enter on a folder to the same handler, leaving the file check to it", () => {
    // The key resolver is row-kind agnostic, so a directory reaches onActivate
    // too. Pinned here because the pane's handler is what filters it — if this
    // ever stopped firing, that guard would look dead and get removed.
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ selectedPath: "src", onActivate });

    fireEvent.keyDown(getByRole("tree"), { key: "Enter" });

    expect(onActivate.mock.calls).toEqual([["src"]]);
  });

  it("does not re-root from a double-click on the chevron", () => {
    // The chevron is the double-click's near-miss zone: a fast expand-collapse
    // there must not yank the user into a new root.
    const onRootFolder = vi.fn();
    const { getByRole } = renderTree({ onRootFolder });

    const chevron = getByRole("treeitem", { name: "src" }).firstElementChild!;
    fireEvent.doubleClick(chevron);

    expect(onRootFolder).not.toHaveBeenCalled();
  });

  it("drops the chevron gutter when the listing holds no folders at all", () => {
    const allFiles = renderTree({ rows: [row("a.ts"), row("b.ts")] });
    // No spacer span before the file icon: the row starts straight at the
    // <svg> so a flat directory of files doesn't carry ghost indentation.
    expect(
      allFiles.getByRole("treeitem", { name: "a.ts" }).firstElementChild?.tagName.toLowerCase()
    ).toBe("svg");
    allFiles.unmount();

    // With any folder present the spacer returns, keeping files aligned.
    const mixed = renderTree();
    expect(
      mixed.getByRole("treeitem", { name: "README.md" }).firstElementChild?.tagName.toLowerCase()
    ).toBe("span");
  });
});

describe("FileTreeView folder-load spinner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no indicator until the anti-flicker gate elapses, then a named status", () => {
    vi.useFakeTimers();
    const loadingRows = [{ ...row("src", true), isLoading: true }];
    // No row menu here: keep the row on its plain path so Radix internals don't
    // interleave with the fake-timer clock.
    const { queryByRole, getByRole, queryByText } = renderTree({
      rows: loadingRows,
      rowContextMenu: undefined,
    });

    // Fast load: nothing during the gate, and the old immediate "Loading…"
    // text is gone entirely.
    expect(queryByRole("status")).toBeNull();
    expect(queryByText(/Loading/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS - 1);
    });
    expect(queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByRole("status", { name: "Loading contents of src" })).toBeTruthy();

    // The nested status must not bleed into the row's own accessible name.
    expect(getByRole("treeitem", { name: "src" })).toBeTruthy();
  });

  it("never shows the indicator when loading resolves before the gate", () => {
    vi.useFakeTimers();
    const { queryByRole, rerender } = renderTree({
      rows: [{ ...row("src", true), isLoading: true }],
      rowContextMenu: undefined,
    });

    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS - 1);
    });
    rerender(
      <FileTreeView
        rows={[row("src", true)]}
        selectedPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        label="Files"
      />
    );
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
    });

    expect(queryByRole("status")).toBeNull();
  });
});

describe("FileTreeView menu contract", () => {
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
