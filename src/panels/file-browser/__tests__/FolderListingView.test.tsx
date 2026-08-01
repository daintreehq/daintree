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

function row(path: string, extra: Partial<FolderListingRow> = {}): FolderListingRow {
  return { path, name: path.split("/").pop()!, isDirectory: false, ...extra };
}

function renderListing(
  rows: FolderListingRow[],
  props: Partial<Parameters<typeof FolderListingView>[0]> = {}
) {
  return render(
    <FolderListingView
      rows={rows}
      selectedPath={null}
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

  it("renders a file's byte size and an em-dash when the size is unknown", () => {
    renderListing([row("src/known.ts", { size: 2048 }), row("src/unknown.ts")]);
    expect(screen.getByText("2 KB")).toBeTruthy();
    // A snapshot-restored row has no size; it must not read as "0 B".
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("reports a folder's item count rather than a byte size", () => {
    renderListing([row("src/pkg", { isDirectory: true, itemCount: 3 })]);
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("singularizes a one-item folder", () => {
    renderListing([row("src/pkg", { isDirectory: true, itemCount: 1 })]);
    expect(screen.getByText("1 item")).toBeTruthy();
  });

  it("shows nothing rather than zero for a folder whose contents are unknown", () => {
    // Never walked, never counted — "0 items" would be a claim the listing has
    // no basis for, since counting means listing.
    renderListing([row("src/pkg", { isDirectory: true })]);
    expect(screen.queryByText("0 items")).toBeNull();
  });

  it("selects a row on single click", () => {
    const onSelect = vi.fn();
    renderListing([row("src/a.ts")], { onSelect });
    fireEvent.click(screen.getByLabelText("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("opens a file in its own panel on double click, mirroring the tree", () => {
    const onActivateFile = vi.fn();
    renderListing([row("src/a.ts")], { onActivateFile });
    fireEvent.doubleClick(screen.getByLabelText("a.ts"));
    expect(onActivateFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("re-roots the browser on a folder double click, mirroring the tree", () => {
    const onRootFolder = vi.fn();
    const onActivateFile = vi.fn();
    renderListing([row("src/pkg", { isDirectory: true })], { onRootFolder, onActivateFile });
    fireEvent.doubleClick(screen.getByLabelText("pkg"));
    expect(onRootFolder).toHaveBeenCalledWith("src/pkg");
    // A folder must never take the file path — the two gestures are distinct.
    expect(onActivateFile).not.toHaveBeenCalled();
  });

  it("marks the selected row as current without claiming list-selection semantics", () => {
    renderListing([row("src/a.ts"), row("src/b.ts")], { selectedPath: "src/a.ts" });
    expect(screen.getByLabelText("a.ts").getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("b.ts").getAttribute("aria-current")).toBeNull();
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
