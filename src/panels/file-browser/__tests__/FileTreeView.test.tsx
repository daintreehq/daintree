// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { forwardRef } from "react";
import type { ReactNode } from "react";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { FILE_DRAG_MIME, decodeFileDragPaths } from "@/lib/fileDragPayload";
import { FileTreeView } from "../FileTreeView";
import type { FlatTreeRow } from "../fileBrowserTree";
import { buildFileBrowserGitStatusIndex } from "../fileBrowserGitStatus";
import { FILE_TREE_ICON_CLASS, getFileTypeIcon } from "../fileTypeIcons";

// `isMac` reads navigator.platform, which jsdom reports as neither — drive it
// explicitly so both modifier branches of the insert shortcut are covered.
const { isMacMock } = vi.hoisted(() => ({ isMacMock: vi.fn<() => boolean>(() => true) }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: isMacMock,
}));

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

/** Absolute root the rows hang off, so a drag can name a real file. */
const BASE_PATH = "/repo";

// One test flips to Ctrl; without this reset it would leak into the rest.
beforeEach(() => {
  isMacMock.mockReturnValue(true);
});

function renderTree(overrides: Partial<Parameters<typeof FileTreeView>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <FileTreeView
      rows={ROWS}
      selectedPath={null}
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
        selectedPath="README.md"
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

  it("hands the selected row to the agent on the platform's insert shortcut", () => {
    const onInsertFileReference = vi.fn();
    const { getByRole } = renderTree({
      selectedPath: "README.md",
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
      selectedPath: "README.md",
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
      selectedPath: "README.md",
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
        selectedPath={null}
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
        selectedPath="README.md"
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
      selectedPath: "some/pruned/path",
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
      selectedPath: "README.md",
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
        selectedPath="README.md"
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
        selectedPath="README.md"
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
        selectedPath="README.md"
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

  it("paints each file with the color its own resolution asked for", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });

    // Compared against the resolver rather than against a literal token, so a
    // renderer that hardcoded one hue for every row would fail here.
    for (const entry of MIXED.filter((candidate) => !candidate.isDirectory)) {
      const className = iconOf(getByRole("treeitem", { name: entry.name })).getAttribute("class");
      expect(className?.split(/\s+/)).toContain(getFileTypeIcon(entry.name).colorClass);
    }
  });

  it("leaves folders on the unclassified file's neutral", () => {
    const { getByRole } = renderTree({ rows: MIXED, rowContextMenu: undefined });
    const classesOf = (name: string) =>
      iconOf(getByRole("treeitem", { name })).getAttribute("class")?.split(/\s+/) ?? [];

    // A folder is one shape for the whole tree, so a hue on it sorts nothing.
    expect(classesOf("src")).toContain(getFileTypeIcon("mystery.qqq").colorClass);
    expect(classesOf("src").some((token) => token.startsWith("text-category-"))).toBe(false);
    // ...but it must still be a folder, not the generic file glyph.
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
        selectedPath={null}
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
        selectedPath={null}
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
        selectedPath={null}
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
