// @vitest-environment jsdom
import { forwardRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { FolderListingRow } from "../fileBrowserTree";

// Render every row: virtualization itself is not under test, and the row
// interactions below need a real DOM node per item.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function VirtuosoStub(
    props: {
      data: FolderListingRow[];
      context: unknown;
      itemContent: (index: number, row: FolderListingRow, context: unknown) => ReactNode;
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

import { FolderListingView } from "../FolderListingView";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { FILE_TREE_ICON_CLASS, FILE_TREE_ICON_COLOR_CLASS } from "../fileTypeIcons";

function row(path: string, extra: Partial<FolderListingRow> = {}): FolderListingRow {
  return { path, name: path.split("/").pop()!, isDirectory: false, ...extra };
}

/** The em-dash the listing renders for a column it has no value for. */
const UNKNOWN = "—";

/**
 * `[name, size, modified]` as actually rendered for one row. Reading all three
 * cells is what makes the unknown-metadata assertions mean something: checking
 * only that "0 B" is absent would also pass for a blank or missing cell.
 */
function cellsOf(name: string): string[] {
  const rowEl = screen.getByLabelText(name);
  return Array.from(rowEl.children).map((cell) => cell.textContent?.trim() ?? "");
}

function renderListing(
  rows: FolderListingRow[],
  props: Partial<Parameters<typeof FolderListingView>[0]> = {}
) {
  return render(
    <FolderListingView
      rows={rows}
      onSelect={vi.fn()}
      basePath="/repo"
      label="Contents of src"
      {...props}
    />
  );
}

describe("FolderListingView", () => {
  it("labels the region so the listing is identifiable without its headers", () => {
    // The column headers are aria-hidden, so the group label is the only
    // accessible name this surface has.
    renderListing([row("src/a.ts")]);
    expect(screen.getByRole("group", { name: "Contents of src" })).toBeTruthy();
  });

  it("hides the column headers from assistive tech", () => {
    // Decorative by contract: sorting lives in the toolbar menu, so headers must
    // not read as sortable columns.
    const { container } = renderListing([row("src/a.ts")]);
    const header = container.querySelector('[aria-hidden="true"]');
    expect(header?.textContent).toContain("Name");
    expect(header?.textContent).toContain("Size");
    expect(header?.textContent).toContain("Modified");
  });

  it("does not mark any header as a sortable column", () => {
    const { container } = renderListing([row("src/a.ts")]);
    expect(container.querySelector("[aria-sort]")).toBeNull();
    expect(container.querySelector("[role='columnheader']")).toBeNull();
  });

  it("renders a file's byte size, and an em-dash in the row that has none", () => {
    renderListing([row("src/known.ts", { size: 2048 }), row("src/unknown.ts")]);
    expect(cellsOf("known.ts")).toEqual(["known.ts", "2 KB", UNKNOWN]);
    // A snapshot-restored row has neither size nor mtime; both cells must say
    // "unknown" rather than "0 B" / a fabricated date.
    expect(cellsOf("unknown.ts")).toEqual(["unknown.ts", UNKNOWN, UNKNOWN]);
  });

  it("renders a modified time when the row carries one", () => {
    renderListing([row("src/a.ts", { size: 1, mtimeMs: Date.now() - 60_000 })]);
    const [, , modified] = cellsOf("a.ts");
    expect(modified).not.toBe(UNKNOWN);
    expect(modified).toMatch(/minute/);
  });

  it("reports a folder's item count rather than a byte size", () => {
    renderListing([row("src/pkg", { isDirectory: true, itemCount: 3 })]);
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("singularizes a one-item folder", () => {
    renderListing([row("src/pkg", { isDirectory: true, itemCount: 1 })]);
    expect(screen.getByText("1 item")).toBeTruthy();
  });

  it("shows an em-dash rather than zero for a folder whose contents are unknown", () => {
    // Never walked, never counted — "0 items" would be a claim the listing has
    // no basis for, since counting means listing.
    renderListing([row("src/pkg", { isDirectory: true })]);
    expect(cellsOf("pkg")).toEqual(["pkg", UNKNOWN, UNKNOWN]);
  });

  it("selects a row on single click", () => {
    const onSelect = vi.fn();
    renderListing([row("src/a.ts")], { onSelect });
    fireEvent.click(screen.getByLabelText("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("makes rows draggable when a base path resolves", () => {
    renderListing([row("src/a.ts")]);
    expect(screen.getByLabelText("a.ts").getAttribute("draggable")).toBe("true");
  });

  it("refuses to advertise a drag with no base path to make it absolute", () => {
    // A drag carrying no data is one Chromium starts and nothing can accept,
    // which reads as broken rather than absent (#11576).
    renderListing([row("src/a.ts")], { basePath: "" });
    expect(screen.getByLabelText("a.ts").getAttribute("draggable")).toBe("false");
  });

  it("wraps rows in a context menu when the pane supplies one", async () => {
    renderListing([row("src/a.ts")], {
      rowContextMenu: (r) => <ContextMenuItem>Copy {r.name}</ContextMenuItem>,
    });
    fireEvent.contextMenu(screen.getByLabelText("a.ts"));
    expect(await screen.findByText("Copy a.ts")).toBeTruthy();
  });

  it("hands the menu builder the same entry shape the tree does", () => {
    // Proves the widened callback signature is satisfied by a listing row —
    // the whole reason both surfaces can share one menu.
    const rowContextMenu = vi.fn(() => <ContextMenuItem>Item</ContextMenuItem>);
    renderListing([row("src/pkg", { isDirectory: true })], { rowContextMenu });
    expect(rowContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/pkg", name: "pkg", isDirectory: true })
    );
  });

  it("renders rows in the order it is given, without re-sorting", () => {
    // Ordering is decided upstream by one comparator shared with the tree; a
    // second sort here could disagree with the column beside it.
    renderListing([row("src/z.ts"), row("src/a.ts")]);
    const names = screen.getAllByText(/\.ts$/).map((node) => node.textContent);
    expect(names).toEqual(["z.ts", "a.ts"]);
  });
});

describe("FolderListingView has no double-click gesture", () => {
  it("treats a real double-click as nothing but its two clicks", () => {
    // A native double-click is click, click, dblclick. If a dblclick handler
    // existed it would fire a third, different action here; the row exposes
    // only selection, so the gesture degrades to two ordinary selects rather
    // than half-invoking something that can't work.
    const onSelect = vi.fn();
    renderListing([row("src/a.ts")], { onSelect });
    const rowEl = screen.getByLabelText("a.ts");
    fireEvent.click(rowEl);
    fireEvent.click(rowEl);
    fireEvent.doubleClick(rowEl);
    expect(onSelect.mock.calls).toEqual([["src/a.ts"], ["src/a.ts"]]);
  });

  it("re-points on a single click, which is what makes a second click land elsewhere", () => {
    const onSelect = vi.fn();
    renderListing([row("src/pkg", { isDirectory: true })], { onSelect });
    fireEvent.click(screen.getByLabelText("pkg"));
    // One selection per click; the pane re-points the listing off the back of
    // it, which is the behaviour that rules a double-click out.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("src/pkg");
  });
});

describe("FolderListingView entry icons", () => {
  /** The row's icon: the listing renders it as the first SVG inside the row. */
  function iconOf(name: string): SVGElement {
    const svg = screen.getByLabelText(name).querySelector("svg");
    if (!svg) throw new Error(`no icon rendered for ${name}`);
    return svg;
  }

  const ROWS = [
    row("src/main.ts"),
    row("src/notes.md"),
    row("src/logo.png"),
    row("src/mystery.qqq"),
    row("src/pkg", { isDirectory: true }),
  ];

  it("paints every entry the same neutral, whatever its type", () => {
    // The tree asserts this for its own rows; the listing is the second
    // renderer of the same icons and diverged from it once already.
    renderListing(ROWS);
    for (const entry of ROWS) {
      const paint = (iconOf(entry.name).getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((token) => token.startsWith("text-"));
      expect(paint, entry.name).toEqual([FILE_TREE_ICON_COLOR_CLASS]);
    }
  });

  it("marks every entry icon for the increased-contrast lift", () => {
    // Without the marker the stylesheet rule in src/index.css cannot reach
    // these icons, and the contract test guarding that rule would still pass.
    renderListing(ROWS);
    for (const entry of ROWS) {
      expect((iconOf(entry.name).getAttribute("class") ?? "").split(/\s+/), entry.name).toContain(
        FILE_TREE_ICON_CLASS
      );
    }
  });

  it("gives a file its type glyph and a directory the folder glyph", () => {
    renderListing(ROWS);
    // Distinctness across categories is proven in fileTypeIcons.test.ts; what
    // this renderer has to get right is wiring type through at all rather than
    // drawing one glyph for every row, which is the bug #11596 fixed.
    expect(iconOf("main.ts").innerHTML).not.toBe(iconOf("logo.png").innerHTML);
    expect(iconOf("main.ts").innerHTML).not.toBe(iconOf("mystery.qqq").innerHTML);
    expect(iconOf("pkg").innerHTML).not.toBe(iconOf("mystery.qqq").innerHTML);
  });

  it("lets a directory outrank a name that would otherwise classify", () => {
    // `archive.zip` resolves to the archive category by name alone, so a
    // renderer that classified before checking isDirectory would draw it as a
    // zip file rather than a folder.
    renderListing([row("src/archive.zip", { isDirectory: true }), row("src/real.zip")]);
    expect(iconOf("archive.zip").innerHTML).not.toBe(iconOf("real.zip").innerHTML);
  });
});
