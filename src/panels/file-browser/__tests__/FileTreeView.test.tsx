// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { StrictMode, forwardRef, useImperativeHandle } from "react";
import type { ForwardedRef, ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { FILE_DRAG_MIME, decodeFileDragPaths } from "@/lib/fileDragPayload";
import { FileTreeView } from "../FileTreeView";
import type { FlatTreeRow } from "../fileBrowserTree";
import { buildFileBrowserGitStatusIndex } from "../fileBrowserGitStatus";
import { FILE_TREE_ICON_CLASS, FILE_TREE_ICON_COLOR_CLASS } from "../fileTypeIcons";

// `isMac` reads navigator.platform, which jsdom reports as neither — drive it
// explicitly so both modifier branches of the insert shortcut are covered.
const { isMacMock } = vi.hoisted(() => ({ isMacMock: vi.fn<() => boolean>(() => true) }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: isMacMock,
}));

/**
 * Scroll requests the tree makes through Virtuoso's imperative handle. The
 * stub has to publish a handle for these to be observable at all: without one
 * the forwarded ref stays null and `virtuosoRef.current?.scrollIntoView(...)`
 * is swallowed by its own optional chaining.
 *
 * Typed from `VirtuosoHandle` rather than by hand so a signature change in the
 * library fails here instead of letting the double drift out of step with what
 * it stands in for.
 */
const { scrollIntoViewMock } = vi.hoisted(() => ({
  scrollIntoViewMock: vi.fn<VirtuosoHandle["scrollIntoView"]>(),
}));

// Render every row: the virtualization itself is not under test, and the row
// interactions below need real DOM nodes for every item.
//
// Spread over the real module so the one export this file replaces doesn't
// take the rest of them down with it — a partial factory turns any future
// `react-virtuoso` import in the tree into a collection-time failure.
//
// The handle stays deliberately minimal. If production starts reaching for
// `scrollToIndex` or `getState`, that should fail loudly here rather than be
// swallowed by a no-op the double was never asked to model.
vi.mock("react-virtuoso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-virtuoso")>()),
  Virtuoso: forwardRef(function VirtuosoStub(
    props: {
      data: FlatTreeRow[];
      context: unknown;
      itemContent: (index: number, row: FlatTreeRow, context: unknown) => ReactNode;
    },
    ref: ForwardedRef<Pick<VirtuosoHandle, "scrollIntoView">>
  ) {
    useImperativeHandle(ref, () => ({ scrollIntoView: scrollIntoViewMock }), []);
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

/** Absolute root the rows hang off, so a drag can name a real file. */
const BASE_PATH = "/repo";

// One test flips to Ctrl; without this reset it would leak into the rest.
beforeEach(() => {
  isMacMock.mockReturnValue(true);
  // Every render with a resolvable cursor scrolls once on mount, so the count
  // carries into the next test without this.
  scrollIntoViewMock.mockClear();
});

function renderTree(overrides: Partial<Parameters<typeof FileTreeView>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <FileTreeView
      rows={ROWS}
      cursorPath={null}
      onSelect={onSelect}
      onToggleExpanded={vi.fn()}
      rowContextMenu={() => <div />}
      basePath={BASE_PATH}
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
        cursorPath="README.md"
        onSelect={onSelect}
        onToggleExpanded={vi.fn()}
        rowContextMenu={(clicked) => <ContextMenuItem>Act on {clicked.name}</ContextMenuItem>}
        basePath={BASE_PATH}
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

    expect(onSelect).toHaveBeenCalledWith("README.md", false);
  });

  it("replays the ContextMenu key as a contextmenu event on the selected row", () => {
    const { getByRole } = renderTree({ cursorPath: "README.md" });
    const contextMenuSpy = vi.fn();
    getByRole("treeitem", { name: "README.md" }).addEventListener("contextmenu", contextMenuSpy);

    const notPrevented = fireEvent.keyDown(getByRole("tree"), { key: "ContextMenu" });

    expect(contextMenuSpy).toHaveBeenCalledTimes(1);
    // preventDefault must fire so the browser's own contextmenu for the
    // keypress cannot double-open the menu.
    expect(notPrevented).toBe(false);
  });

  it("replays Shift+F10 but leaves plain F10 alone", () => {
    const { getByRole } = renderTree({ cursorPath: "src" });
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

  it("hands the selected row to the agent on the platform's insert shortcut", () => {
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      cursorPath: "README.md",
      onInsertFileReference,
      canInsertFileReference: true,
    });

    const event = new KeyboardEvent("keydown", {
      key: "i",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      getByRole("tree").dispatchEvent(event);
    });

    expect(onInsertFileReference.mock.calls).toEqual([["README.md"]]);
    // Consumed so the combo can't also reach a global handler.
    expect(event.defaultPrevented).toBe(true);
  });

  it("uses Ctrl rather than Cmd off macOS", () => {
    isMacMock.mockReturnValue(false);
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      cursorPath: "README.md",
      onInsertFileReference,
      canInsertFileReference: true,
    });
    const tree = getByRole("tree");

    fireEvent.keyDown(tree, { key: "i", ctrlKey: true });
    expect(onInsertFileReference.mock.calls).toEqual([["README.md"]]);

    // The mac modifier must not also fire it, or a Windows user's Cmd-mapped
    // key would double-insert.
    fireEvent.keyDown(tree, { key: "i", metaKey: true });
    expect(onInsertFileReference).toHaveBeenCalledTimes(1);
  });

  it("leaves the bare letter and the inject combo to their own handlers", () => {
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      cursorPath: "README.md",
      onInsertFileReference,
      canInsertFileReference: true,
    });
    const tree = getByRole("tree");

    fireEvent.keyDown(tree, { key: "i" });
    // Cmd+Shift+I belongs to terminal.inject.
    fireEvent.keyDown(tree, { key: "i", metaKey: true, shiftKey: true });

    expect(onInsertFileReference).not.toHaveBeenCalled();
  });

  it("no-ops the shortcut with no selection or no reachable agent", () => {
    const onInsertFileReference = vi.fn();
    const { getByRole, rerender } = render(
      <FileTreeView
        rows={ROWS}
        cursorPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        rowContextMenu={() => <div />}
        onInsertFileReference={onInsertFileReference}
        canInsertFileReference
        basePath={BASE_PATH}
        label="Files"
      />
    );

    fireEvent.keyDown(getByRole("tree"), { key: "i", metaKey: true });
    expect(onInsertFileReference).not.toHaveBeenCalled();

    // A selected row but no resolvable agent must stay inert too — refusing is
    // the contract, not routing into whatever happens to be open.
    rerender(
      <FileTreeView
        rows={ROWS}
        cursorPath="README.md"
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        rowContextMenu={() => <div />}
        onInsertFileReference={onInsertFileReference}
        canInsertFileReference={false}
        basePath={BASE_PATH}
        label="Files"
      />
    );

    fireEvent.keyDown(getByRole("tree"), { key: "i", metaKey: true });
    expect(onInsertFileReference).not.toHaveBeenCalled();
  });

  it("ignores a selection that no longer resolves to a row", () => {
    // Re-rooting the tree leaves browserSelectedPath naming the old root, which
    // is no longer in `rows`. Firing then would reference a row the user can't
    // see and that aria-activedescendant has already disowned.
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      cursorPath: "some/pruned/path",
      onInsertFileReference,
      canInsertFileReference: true,
    });

    fireEvent.keyDown(getByRole("tree"), { key: "i", metaKey: true });

    expect(onInsertFileReference).not.toHaveBeenCalled();
    expect(getByRole("tree").hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("ignores auto-repeat so a held combo inserts once", () => {
    // Beyond the obvious spam: the global keybinding handler drops repeats, so
    // a user-rebound global Cmd+I would run its own action on the first press
    // and let every repeat fall through to here — a genuine wrong action.
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      cursorPath: "README.md",
      onInsertFileReference,
      canInsertFileReference: true,
    });
    const tree = getByRole("tree");

    fireEvent.keyDown(tree, { key: "i", metaKey: true });
    fireEvent.keyDown(tree, { key: "i", metaKey: true, repeat: true });
    fireEvent.keyDown(tree, { key: "i", metaKey: true, repeat: true });

    expect(onInsertFileReference).toHaveBeenCalledTimes(1);
  });

  it("acts on nothing for keys pressed inside an open row menu", async () => {
    // The menu portals out of the container but still bubbles through the React
    // tree. Every branch is affected, not just the new one: Enter would
    // activate the SELECTED row while the user is driving a menu opened on a
    // different one, and arrows would move the selection behind the open menu.
    const onInsertFileReference = vi.fn();
    const onActivate = vi.fn();
    const onSelect = vi.fn();
    const { getByRole, findByRole } = render(
      <FileTreeView
        rows={ROWS}
        cursorPath="README.md"
        onSelect={onSelect}
        onToggleExpanded={vi.fn()}
        onActivate={onActivate}
        rowContextMenu={(clicked) => <ContextMenuItem>Act on {clicked.name}</ContextMenuItem>}
        onInsertFileReference={onInsertFileReference}
        canInsertFileReference
        basePath={BASE_PATH}
        label="Files"
      />
    );

    fireEvent.contextMenu(getByRole("treeitem", { name: "src" }));
    const item = await findByRole("menuitem", { name: "Act on src" });

    fireEvent.keyDown(item, { key: "i", metaKey: true });
    fireEvent.keyDown(item, { key: "ArrowDown" });

    expect(onInsertFileReference).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("advertises the shortcut only while it would do something", () => {
    const { getByRole, rerender } = render(
      <FileTreeView
        rows={ROWS}
        cursorPath="README.md"
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        onInsertFileReference={vi.fn()}
        canInsertFileReference
        basePath={BASE_PATH}
        label="Files"
      />
    );
    expect(getByRole("tree").getAttribute("aria-keyshortcuts")).toBe("Meta+I");

    rerender(
      <FileTreeView
        rows={ROWS}
        cursorPath="README.md"
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        onInsertFileReference={vi.fn()}
        canInsertFileReference={false}
        basePath={BASE_PATH}
        label="Files"
      />
    );
    expect(getByRole("tree").hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("routes double-click to activate for both row kinds", () => {
    // One command for folders and files alike, and the same one Enter runs.
    // Folders used to re-root from here instead (#11496), which spent the
    // universal "activate this" gesture on a structural jump.
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ onActivate });

    fireEvent.doubleClick(getByRole("treeitem", { name: "src" }));
    fireEvent.doubleClick(getByRole("treeitem", { name: "README.md" }));

    expect(onActivate.mock.calls).toEqual([["src"], ["README.md"]]);
  });

  it("activates the selected row on Enter and consumes the key", () => {
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ cursorPath: "README.md", onActivate });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      getByRole("tree").dispatchEvent(event);
    });

    expect(onActivate.mock.calls).toEqual([["README.md"]]);
    // Handled keys are prevented so Enter doesn't also reach an outer surface.
    expect(event.defaultPrevented).toBe(true);
  });

  it("reports Enter on a folder to the same handler, leaving the routing to it", () => {
    // The key resolver is row-kind agnostic, so a directory reaches onActivate
    // too. Pinned here because Enter is now a folder's ONLY keyboard route to
    // the viewer — clicking one is pure navigation — so if this stopped firing
    // the folder listing would become unreachable from the keyboard entirely.
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ cursorPath: "src", onActivate });

    fireEvent.keyDown(getByRole("tree"), { key: "Enter" });

    expect(onActivate.mock.calls).toEqual([["src"]]);
  });

  // The tree reports WHICH KIND of row the cursor landed on, and the pane uses
  // that to decide whether the viewer column moves with it. Without the kind
  // travelling on the callback the pane would have to re-derive it from a
  // listings cache that does not answer for every path, which is exactly the
  // coupling this split removes.
  it("marks the open row apart from the cursor row", () => {
    // Once the two can differ, aria-selected alone says nothing about which row
    // the viewer belongs to — a screen-reader user would have no way to
    // perceive it. They ride separate attributes on purpose.
    const { getByRole } = renderTree({ cursorPath: "src", openPath: "README.md" });

    const cursorRow = getByRole("treeitem", { name: "src" });
    const openRow = getByRole("treeitem", { name: "README.md" });

    expect(cursorRow.getAttribute("aria-selected")).toBe("true");
    expect(cursorRow.getAttribute("aria-current")).toBeNull();
    expect(openRow.getAttribute("aria-current")).toBe("true");
    expect(openRow.getAttribute("aria-selected")).toBe("false");
  });

  it("marks nothing current when the viewer is showing no row", () => {
    const { getByRole } = renderTree({ cursorPath: "src" });

    expect(getByRole("treeitem", { name: "src" }).getAttribute("aria-current")).toBeNull();
    expect(getByRole("treeitem", { name: "README.md" }).getAttribute("aria-current")).toBeNull();
  });

  it("carries the row kind on a click so the pane can route it", () => {
    const { onSelect, getByRole } = renderTree();

    fireEvent.click(getByRole("treeitem", { name: "src" }));
    fireEvent.click(getByRole("treeitem", { name: "README.md" }));

    expect(onSelect.mock.calls).toEqual([
      ["src", true],
      ["README.md", false],
    ]);
  });

  it("carries the row kind when the cursor moves by keyboard", () => {
    // Arrowing is navigation too: landing on a folder must be reported as one
    // so a held ArrowDown cannot walk the viewer through every directory it
    // passes.
    const { onSelect, getByRole, rerender } = renderTree();

    fireEvent.keyDown(getByRole("tree"), { key: "ArrowDown" });
    expect(onSelect.mock.calls).toEqual([["src", true]]);

    rerender(
      <FileTreeView
        rows={ROWS}
        cursorPath="src"
        onSelect={onSelect}
        onToggleExpanded={vi.fn()}
        rowContextMenu={() => <div />}
        basePath={BASE_PATH}
        label="Files"
      />
    );
    fireEvent.keyDown(getByRole("tree"), { key: "ArrowDown" });

    expect(onSelect.mock.calls).toEqual([
      ["src", true],
      ["README.md", false],
    ]);
  });

  it("does not activate from a double-click on the chevron", () => {
    // The chevron is the double-click's near-miss zone: a fast expand-collapse
    // there must not move the viewer the user never asked to move.
    const onActivate = vi.fn();
    const { getByRole } = renderTree({ onActivate });

    const chevron = getByRole("treeitem", { name: "src" }).firstElementChild!;
    fireEvent.doubleClick(chevron);

    expect(onActivate).not.toHaveBeenCalled();
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

describe("FileTreeView row icons", () => {
  // One row per visibly different kind of file, plus a folder and an
  // unclassifiable name.
  const MIXED = [
    row("src", true),
    row("clip.mp4"),
    row("index.json"),
    row("logo.png"),
    row("bundle.zip"),
    row("main.ts"),
    row("mystery.qqq"),
  ];

  /** The row's icon: the direct <svg> child, past the chevron gutter if present. */
  function iconOf(element: Element): SVGElement {
    const svg = element.querySelector(":scope > svg");
    if (!(svg instanceof SVGElement)) {
      throw new Error(`no direct <svg> child on row ${element.getAttribute("aria-label")}`);
    }
    return svg;
  }

  it("gives each file kind its own glyph", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });

    const shapes = ["clip.mp4", "index.json", "logo.png", "bundle.zip", "main.ts"].map(
      (name) => iconOf(getByRole("treeitem", { name })).innerHTML
    );

    // The bug this fixes was every row drawing the same glyph.
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("keeps every entry icon decorative and unwrapped", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });

    for (const entry of MIXED) {
      // Wrapping the icon would break the tree's first-child layout contract
      // asserted above, so assert the direct-child relationship per row.
      const icon = iconOf(getByRole("treeitem", { name: entry.name }));
      // The row already announces the filename; a second spoken label would
      // just repeat the extension on every arrow-key move.
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("paints every row the same neutral, whatever its type", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });
    const classesOf = (name: string) =>
      iconOf(getByRole("treeitem", { name })).getAttribute("class")?.split(/\s+/) ?? [];

    // Files and folders share one paint contract: type is carried by the glyph
    // alone. Asserting the neutral is the row's *only* color utility, not
    // merely present — a per-type hue added alongside it would otherwise pass.
    for (const entry of MIXED) {
      const paint = classesOf(entry.name).filter((token) => token.startsWith("text-"));
      expect(paint, entry.name).toEqual([FILE_TREE_ICON_COLOR_CLASS]);
    }

    // ...and a folder must still be a folder, not the generic file glyph.
    expect(iconOf(getByRole("treeitem", { name: "src" })).innerHTML).not.toBe(
      iconOf(getByRole("treeitem", { name: "mystery.qqq" })).innerHTML
    );
  });

  it("marks every entry icon for the increased-contrast repaint", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });

    // The stylesheet's `prefers-contrast: more` rule keys off this class; the
    // contract test guards the other half.
    for (const entry of MIXED) {
      const className = iconOf(getByRole("treeitem", { name: entry.name })).getAttribute("class");
      expect(className?.split(/\s+/)).toContain(FILE_TREE_ICON_CLASS);
    }
  });

  it("never dims an entry icon into invisibility or reaches for the accent", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });

    for (const entry of MIXED) {
      const className = iconOf(getByRole("treeitem", { name: entry.name })).getAttribute("class");
      // The `/30`-`/40` alpha is exactly the "near invisible" complaint.
      expect(className).not.toMatch(/text-[a-z-]+\/\d/);
      expect(className).not.toMatch(/\bopacity-/);
      // Accent restraint: never dozens of rows at once.
      expect(className).not.toMatch(/accent/);
    }
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
        cursorPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        basePath={BASE_PATH}
        label="Files"
      />
    );
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS);
    });

    expect(queryByRole("status")).toBeNull();
  });
});

describe("FileTreeView drag source", () => {
  /**
   * jsdom ships no `DataTransfer`, and the real one has a read-only `types`
   * anyway. A Map-backed stand-in records exactly what the source wrote, which
   * is the contract the two drop handlers read back.
   */
  function dragStart(element: Element) {
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
      setDragImage: vi.fn(),
      effectAllowed: "uninitialized",
    };
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    fireEvent(element, event);
    return { data, dataTransfer, event };
  }

  it("carries the row's absolute path as a list", () => {
    const { getByRole } = renderTree();

    const { data } = dragStart(getByRole("treeitem", { name: "README.md" }));

    expect(decodeFileDragPaths(data.get(FILE_DRAG_MIME)!)).toEqual(["/repo/README.md"]);
  });

  // Rows are relative to the base path, so a drag that skipped the join would
  // hand the agent a path resolving against its own cwd instead of the file's.
  it("joins nested rows onto the base path", () => {
    const { getByRole } = renderTree({ rows: [row("src/components/App.tsx")] });

    const { data } = dragStart(getByRole("treeitem", { name: "App.tsx" }));

    expect(decodeFileDragPaths(data.get(FILE_DRAG_MIME)!)).toEqual([
      "/repo/src/components/App.tsx",
    ]);
  });

  // Directory references are meaningful to the agents, so folders drag on
  // exactly the same terms as files.
  it("drags folders too", () => {
    const { getByRole } = renderTree();
    const folder = getByRole("treeitem", { name: "src" });

    expect(folder.getAttribute("draggable")).toBe("true");
    const { data } = dragStart(folder);

    expect(decodeFileDragPaths(data.get(FILE_DRAG_MIME)!)).toEqual(["/repo/src"]);
  });

  // A `text/plain` twin would be inserted a second time by CodeMirror's own
  // drop handler, which sits inside the element carrying the hybrid input's,
  // and would put the drag beyond the app-wide invalid-target guard.
  it("carries no other type alongside the payload", () => {
    const { getByRole } = renderTree();

    const { data } = dragStart(getByRole("treeitem", { name: "README.md" }));

    expect([...data.keys()]).toEqual([FILE_DRAG_MIME]);
  });

  it("advertises a copy and previews the row itself", () => {
    const { getByRole } = renderTree();
    const rowElement = getByRole("treeitem", { name: "README.md" });

    const { dataTransfer } = dragStart(rowElement);

    // Referencing a file never moves or removes it.
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(
      rowElement,
      expect.any(Number),
      expect.any(Number)
    );
  });

  // With no base path the row cannot name an absolute file, so there is
  // nothing to drag — and a drag carrying no data is one no target can accept,
  // which reads as broken rather than absent.
  it("does not drag when no base path resolves", () => {
    const { getByRole } = renderTree({ basePath: "" });
    const rowElement = getByRole("treeitem", { name: "README.md" });

    expect(rowElement.getAttribute("draggable")).toBe("false");

    const { data, event } = dragStart(rowElement);
    expect(data.size).toBe(0);
    expect(event.defaultPrevented).toBe(true);
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
        cursorPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        basePath={BASE_PATH}
        label="Files"
      />
    );
    expect(getByRole("tree").hasAttribute("data-row-menu")).toBe(false);
  });
});

// Git status markers (#11614). The index is a parallel channel to `rows` — a
// directory listing doesn't change when a file's status does — so these prove
// the join and the invalidation seam, not the rows.
describe("FileTreeView git status markers", () => {
  /** What the row's status is announced as, via its description. */
  function describedStatus(container: HTMLElement, name: string): string | null {
    const treeitem = container.querySelector(`[role="treeitem"][aria-label="${name}"]`);
    const describedBy = treeitem?.getAttribute("aria-describedby");
    if (!describedBy) return null;
    // getElementById rather than a `#id` selector: row ids are URI-encoded
    // paths, which need escaping the jsdom build here has no `CSS.escape` for.
    const target = container.ownerDocument.getElementById(describedBy);
    if (!target) return null;
    // What a screen reader actually computes: an accessible description skips
    // aria-hidden content, so the decorative marker letter drops out and only
    // the spelled-out status is announced. Raw textContent would run the two
    // together and assert a string no user ever hears.
    const announced = target.cloneNode(true);
    if (!(announced instanceof HTMLElement)) return null;
    for (const hidden of announced.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return announced.textContent;
  }

  const NESTED_ROWS = [row("src", true), row("src/app.ts"), row("README.md")];

  it("marks a changed file and leaves its unchanged siblings bare", () => {
    const { container } = renderTree({
      rows: NESTED_ROWS,
      gitStatusIndex: buildFileBrowserGitStatusIndex([
        { relativePath: "src/app.ts", status: "modified" },
      ]),
    });

    expect(describedStatus(container, "app.ts")).toBe("Modified");
    expect(describedStatus(container, "README.md")).toBeNull();
  });

  it("marks a collapsed folder from a descendant it has never listed", () => {
    // `src` is collapsed, so no child row exists for the changed file at all —
    // the aggregate is the only thing that can surface it.
    const { container } = renderTree({
      rows: [row("src", true), row("README.md")],
      gitStatusIndex: buildFileBrowserGitStatusIndex([
        { relativePath: "src/deep/nested/app.ts", status: "modified" },
      ]),
    });

    expect(describedStatus(container, "src")).toBe("Contains modified changes");
  });

  it("phrases a folder as containing changes, not as being changed itself", () => {
    const { container } = renderTree({
      rows: NESTED_ROWS,
      gitStatusIndex: buildFileBrowserGitStatusIndex([
        { relativePath: "src/app.ts", status: "added" },
      ]),
    });

    expect(describedStatus(container, "src")).toBe("Contains added changes");
    expect(describedStatus(container, "app.ts")).toBe("Added");
  });

  it("shows a folder its most urgent descendant when several changed", () => {
    const { container } = renderTree({
      rows: [row("src", true)],
      gitStatusIndex: buildFileBrowserGitStatusIndex([
        { relativePath: "src/a.ts", status: "untracked" },
        { relativePath: "src/b.ts", status: "conflicted" },
      ]),
    });

    expect(describedStatus(container, "src")).toBe("Contains conflicted changes");
  });

  it("renders no markers at all when the source has no git behind it", () => {
    const { container } = renderTree({ rows: NESTED_ROWS, gitStatusIndex: null });

    expect(container.querySelector("[aria-describedby]")).toBeNull();
  });

  it("repaints markers when only the index changes, with identical rows", () => {
    // The invalidation seam: an agent editing a file moves the status without
    // touching the listing, so a marker that only followed `rows` would be
    // stale until the next expansion.
    const { container, rerender } = renderTree({
      rows: NESTED_ROWS,
      gitStatusIndex: buildFileBrowserGitStatusIndex([]),
    });
    expect(describedStatus(container, "app.ts")).toBeNull();

    rerender(
      <FileTreeView
        rows={NESTED_ROWS}
        cursorPath={null}
        onSelect={vi.fn()}
        onToggleExpanded={vi.fn()}
        rowContextMenu={() => <div />}
        basePath={BASE_PATH}
        label="Files"
        gitStatusIndex={buildFileBrowserGitStatusIndex([
          { relativePath: "src/app.ts", status: "conflicted" },
        ])}
      />
    );

    expect(describedStatus(container, "app.ts")).toBe("Conflicted");
  });

  it("keeps the row's accessible name the filename alone", () => {
    // Folding status into the name would rewrite every accessible row query and
    // re-announce the row as a different thing on each agent write.
    const { getByRole } = renderTree({
      rows: NESTED_ROWS,
      gitStatusIndex: buildFileBrowserGitStatusIndex([
        { relativePath: "src/app.ts", status: "modified" },
      ]),
    });

    expect(getByRole("treeitem", { name: "app.ts" })).toBeTruthy();
  });

  it("shows the status marker alongside a folder's loading spinner", async () => {
    vi.useFakeTimers();
    try {
      const loadingFolder: FlatTreeRow = { ...row("src", true), isLoading: true };
      const { container } = renderTree({
        rows: [loadingFolder],
        gitStatusIndex: buildFileBrowserGitStatusIndex([
          { relativePath: "src/app.ts", status: "modified" },
        ]),
      });

      await act(async () => {
        vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS + 10);
      });

      expect(describedStatus(container, "src")).toBe("Contains modified changes");
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FileTreeView cursor reveal", () => {
  const COLLAPSED: FlatTreeRow[] = [row("src", true), row("lib", true), row("README.md")];
  const SRC_EXPANDED: FlatTreeRow[] = [
    { ...row("src", true), isExpanded: true },
    { ...row("src/a.ts"), depth: 1 },
    { ...row("src/b.ts"), depth: 1 },
    row("lib", true),
    row("README.md"),
  ];
  const BOTH_EXPANDED: FlatTreeRow[] = [
    { ...row("src", true), isExpanded: true },
    { ...row("src/a.ts"), depth: 1 },
    { ...row("src/b.ts"), depth: 1 },
    { ...row("lib", true), isExpanded: true },
    { ...row("lib/util.ts"), depth: 1 },
    row("README.md"),
  ];

  /**
   * Which rows the tree asked Virtuoso to reveal, resolved back through the
   * rows it was rendering. The invariant is *which row* got revealed — the
   * number its position happened to carry is an implementation detail, and
   * asserting it would only restate the fixture.
   */
  function revealedPaths(rows: FlatTreeRow[]): (string | undefined)[] {
    return scrollIntoViewMock.mock.calls.map(([location]) => {
      if (typeof location !== "object" || location === null || !("index" in location)) {
        return undefined;
      }
      const { index } = location;
      return typeof index === "number" ? rows[index]?.path : undefined;
    });
  }

  function renderCursor(rows: FlatTreeRow[], cursorPath: string | null) {
    const props = {
      rows,
      cursorPath,
      onSelect: vi.fn(),
      onToggleExpanded: vi.fn(),
      basePath: BASE_PATH,
      label: "Files",
    };
    const utils = render(<FileTreeView {...props} />);
    return {
      ...utils,
      /**
       * Commit a new tree the way the pane does. Both arguments are required:
       * defaulting the cursor would silently restore it from the first render
       * rather than from the last commit.
       */
      show: (nextRows: FlatTreeRow[], nextCursorPath: string | null) =>
        utils.rerender(<FileTreeView {...props} rows={nextRows} cursorPath={nextCursorPath} />),
    };
  }

  it("reveals a restored cursor on mount", () => {
    // The cursor a restored panel comes back with is off screen as often as
    // not, so the first commit that resolves it has to scroll.
    renderCursor(COLLAPSED, "README.md");

    expect(revealedPaths(COLLAPSED)).toEqual(["README.md"]);
  });

  it("leaves the view alone while folders above the cursor expand", () => {
    // #11684: expanding splices rows in above a stationary cursor, so its index
    // changes without the cursor having moved. Scrolling for that is what drags
    // the list away from the folder the user just opened — and it compounds,
    // because opening one big folder is what makes the tree long enough to
    // scroll before the next folder is opened at all.
    const { show } = renderCursor(COLLAPSED, "README.md");
    scrollIntoViewMock.mockClear();

    // The folder flips to expanded while its listing is still in flight...
    show(
      [
        { ...row("src", true), isExpanded: true, isLoading: true },
        row("lib", true),
        row("README.md"),
      ],
      "README.md"
    );
    // ...its children land a beat later, shifting the cursor row down...
    show(SRC_EXPANDED, "README.md");
    // ...and a second folder opens below the first, shifting it again.
    show(BOTH_EXPANDED, "README.md");

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("reveals the cursor when it moves to a row holding the same position", () => {
    // Sorting the same two rows the other way round moves the cursor to a
    // different file that lands on the index the old one just vacated. What
    // makes this a move is the path, so keying off the index alone would miss
    // it entirely.
    const ascending = [row("a.ts"), row("b.ts")];
    const descending = [row("b.ts"), row("a.ts")];
    const { show } = renderCursor(ascending, "a.ts");
    scrollIntoViewMock.mockClear();

    show(descending, "b.ts");

    expect(revealedPaths(descending)).toEqual(["b.ts"]);
  });

  it("reveals a cursor whose row only appears once its ancestors expand", () => {
    // The reveal flow sets `cursorPath` to the target before anything expands,
    // so the row does not exist yet and `cursorPath` never changes again. Only
    // the row appearing marks the moment there is something to scroll to.
    const { show } = renderCursor(COLLAPSED, "src/b.ts");
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    show(SRC_EXPANDED, "src/b.ts");

    expect(revealedPaths(SRC_EXPANDED)).toEqual(["src/b.ts"]);
  });

  it("re-reveals a cursor whose row disappears and comes back", () => {
    const { show } = renderCursor(SRC_EXPANDED, "src/b.ts");
    scrollIntoViewMock.mockClear();

    // Collapsing the branch takes the row away — nothing to reveal.
    show(COLLAPSED, "src/b.ts");
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    show(SRC_EXPANDED, "src/b.ts");

    expect(revealedPaths(SRC_EXPANDED)).toEqual(["src/b.ts"]);
  });

  it("does not reveal a cursor that moves to a path with no row", () => {
    // Re-rooting leaves the cursor naming a path this tree cannot show. The
    // move is real, but there is no row to scroll to, so the reachability
    // check has to win over it.
    const { show } = renderCursor(COLLAPSED, "README.md");
    scrollIntoViewMock.mockClear();

    show(COLLAPSED, "somewhere/else.ts");

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("reveals a restored cursor exactly once under StrictMode replay", () => {
    // The app mounts under StrictMode, which runs each render twice and replays
    // effects. Two calls would mean the replay duplicated the request; zero
    // would mean the mount reveal was suppressed — which is what tracking the
    // previous cursor during render instead of after commit would cause, since
    // the second render pass would have already marked it seen.
    render(
      <StrictMode>
        <FileTreeView
          rows={COLLAPSED}
          cursorPath="README.md"
          onSelect={vi.fn()}
          onToggleExpanded={vi.fn()}
          basePath={BASE_PATH}
          label="Files"
        />
      </StrictMode>
    );

    expect(revealedPaths(COLLAPSED)).toEqual(["README.md"]);
  });
});
