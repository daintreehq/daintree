// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";
import { usesRichDataTable } from "@/components/PluginKit/PluginKitDataTables";
import {
  formatNumeric,
  readNumericFormat,
  sumField,
  type NumericFormat,
} from "@/components/PluginKit/kitNumericFormat";

beforeAll(async () => {
  await primeRadix();
  render(createElement(kit.Spinner));
  await vi.waitFor(
    () => {
      if (!document.querySelector(".animate-spin")) throw new Error("kit not loaded");
    },
    { timeout: 5_000 }
  );
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function inViewport(children: ReactNode) {
  return createElement(
    TooltipProvider,
    null,
    createElement(
      VirtuosoMockContext.Provider,
      { value: { viewportHeight: 600, itemHeight: 28 } },
      children
    )
  );
}

interface Entry {
  id: string;
  item: string;
  category: string;
  amount: number;
  note?: string;
  children?: Entry[];
}

const ENTRIES: Entry[] = [
  { id: "e1", item: "Rent", category: "Home", amount: 1200 },
  { id: "e2", item: "Power", category: "Home", amount: 85.5 },
  { id: "e3", item: "Refund", category: "Other", amount: -40.25 },
  {
    id: "e4",
    item: "Groceries",
    category: "Food",
    amount: 310,
    children: [{ id: "e4a", item: "Market", category: "Food", amount: 999 }],
  },
];

const USD: NumericFormat = { currency: "USD", decimals: undefined, negative: "minus" };

const bodyRows = (root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>("tbody tr")].filter((row) => row.querySelector("td"));

function rowNamed(name: string) {
  const row = bodyRows().find((candidate) => within(candidate).queryByText(name));
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

describe("numeric formatting", () => {
  it("draws a true minus, or brackets, and never a signed zero", () => {
    expect(formatNumeric(-1234.5, USD, "en-US")).toBe("\u2212$1,234.50");
    expect(formatNumeric(-1234.5, { ...USD, negative: "parens" }, "en-US")).toBe("($1,234.50)");
    expect(formatNumeric(1234.5, USD, "en-US")).toBe("$1,234.50");
    const plain: NumericFormat = { currency: undefined, decimals: undefined, negative: "minus" };
    expect(formatNumeric(-3.14159, plain, "en-US")).toBe("\u22123.14");
    expect(formatNumeric(-0.001, plain, "en-US")).toBe("0");
    expect(formatNumeric(-0.001, { ...plain, negative: "parens" }, "en-US")).toBe("0");
    expect(formatNumeric(2.5, { ...plain, decimals: 3 }, "en-US")).toBe("2.500");
    expect(formatNumeric(-7, { ...USD, decimals: 0 }, "en-US")).toBe("\u2212$7");
    expect(formatNumeric(-0, plain, "en-US")).toBe("0");
    // The sign follows the figure as drawn, not a separate rounding of it.
    expect(formatNumeric(-5e-7, { ...plain, decimals: 6 }, "en-US")).toBe("\u22120.000001");
  });

  it("reads a format from untyped input and drops what it cannot use", () => {
    expect(readNumericFormat(true)).toBeNull();
    expect(readNumericFormat({ currency: "EUR", negative: "parens", decimals: 1 })).toEqual({
      currency: "EUR",
      decimals: 1,
      negative: "parens",
    });
    expect(readNumericFormat({ currency: "euros", decimals: -1, negative: "red" })).toEqual({
      currency: undefined,
      decimals: undefined,
      negative: "minus",
    });
  });

  it("sums only finite numbers, without float drift", () => {
    expect(sumField([{ v: 0.1 }, { v: 0.2 }, { v: "3" }, { v: Number.NaN }, null], "v")).toBe(0.3);
    expect(sumField([{ v: "x" }], "v")).toBeNull();
    expect(sumField([{ v: 1e-11 }], "v")).toBe(1e-11);
    expect(sumField([{ v: 1e16 }, { v: 1 }, { v: -1e16 }], "v")).toBe(1);
  });
});

describe("DataTable as a ledger", () => {
  it("draws every row in a plain table that sizes to its content", () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: `r${index}`,
      item: `Line ${index}`,
      category: "All",
      amount: index,
    }));
    expect(usesRichDataTable({ virtualize: false })).toBe(true);
    expect(usesRichDataTable({ virtualize: true })).toBe(false);
    expect(usesRichDataTable({ totals: { amount: "sum" }, density: "compact" })).toBe(false);
    // No viewport mock: a virtualised table would draw nothing here.
    const { container } = render(
      createElement(kit.DataTable<Entry>, {
        "aria-label": "Lines",
        rows,
        rowKey: "id",
        columns: [
          { id: "item", header: "Item" },
          { id: "amount", header: "Amount", numeric: true },
        ],
        virtualize: false,
        "data-testid": "lines",
      })
    );
    expect(bodyRows(container)).toHaveLength(300);
    expect(container.querySelector("[data-virtuoso-scroller]")).toBeNull();
    const root = screen.getByTestId("lines");
    expect(root.style.height).toBe("");
    expect(root.className).toContain("overflow-x-auto");
    expect(root.querySelector("thead th")?.textContent).toBe("Item");
  });

  it("keeps the keyboard grid without the virtualiser, scrolling the row into view", () => {
    const scrolled: Element[] = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
    const onRowClick = vi.fn();
    try {
      render(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Ledger",
          rows: ENTRIES,
          rowKey: "id",
          columns: [{ id: "item", header: "Item" }],
          virtualize: false,
          onRowClick,
        })
      );
      const grid = screen.getByRole("grid", { name: "Ledger" });
      act(() => grid.focus());
      fireEvent.keyDown(grid, { key: "ArrowDown" });
      expect(rowNamed("Power").getAttribute("data-active")).toBe("true");
      expect(scrolled.at(-1)).toBe(rowNamed("Power"));
      fireEvent.keyDown(grid, { key: "Enter" });
      expect(onRowClick).toHaveBeenLastCalledWith(ENTRIES[1], 1);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("points the grid at its cursor row after the virtualiser is turned off", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `r${index}`,
      item: `Line ${index}`,
      category: "All",
      amount: index,
    }));
    const table = (virtualize: boolean) =>
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 84, itemHeight: 28 } },
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Switch",
          rows,
          rowKey: "id",
          columns: [{ id: "item", header: "Item" }],
          stickyFirstColumn: true,
          onRowClick: () => {},
          virtualize,
        })
      );
    const { rerender } = render(table(true));
    rerender(table(false));
    const grid = screen.getByRole("grid", { name: "Switch" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "End" });
    const last = rowNamed("Line 39");
    expect(last.getAttribute("data-active")).toBe("true");
    expect(grid.getAttribute("aria-activedescendant")).toBe(last.id);
  });

  it("draws totals in a tfoot over exactly `rows`, with the label in the first free column", () => {
    const { container } = render(
      createElement(kit.DataTable<Entry>, {
        "aria-label": "Totals",
        rows: ENTRIES,
        rowKey: "id",
        columns: [
          { id: "item", header: "Item" },
          { id: "category", header: "Category" },
          { id: "amount", header: "Amount", numeric: { currency: "USD" } },
        ],
        getSubRows: (row) => row.children,
        defaultExpandedRowKeys: ["e4"],
        virtualize: false,
        totals: {
          item: (rows) => `${rows.length} items`,
          amount: "sum",
        },
      })
    );
    // The expanded child is drawn but not counted.
    expect(rowNamed("Market")).toBeTruthy();
    const cells = [...container.querySelectorAll("tfoot td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["4 items", "Total", "$1,555.25"]);
    const foot = container.querySelector("tfoot tr")!;
    expect(foot.getAttribute("aria-rowindex")).toBe(
      container.querySelector("table")!.getAttribute("aria-rowcount")
    );
  });

  it("labels a totals row as asked, and keeps it in the virtualised table's footer", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Pinned totals",
          rows: ENTRIES,
          rowKey: "id",
          columns: [
            { id: "item", header: "Item" },
            { id: "amount", header: "Amount", numeric: { negative: "parens" } },
          ],
          totals: { amount: (rows) => rows.filter((row) => row.amount < 0).length },
          totalsLabel: "Refunds",
        })
      )
    );
    expect(container.querySelector("[data-virtuoso-scroller]")).not.toBeNull();
    const cells = [...container.querySelectorAll("tfoot td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["Refunds", "1"]);
    expect(within(rowNamed("Refund")).getByText("(40.25)")).toBeTruthy();
  });

  it("puts subtotals on group headers, folded or not, and drops the count on request", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Grouped",
          rows: ENTRIES,
          rowKey: "id",
          columns: [
            { id: "item", header: "Item", numeric: true },
            { id: "category", header: "Category" },
            { id: "amount", header: "Amount", numeric: { currency: "USD" } },
            { id: "note", header: "Note" },
          ],
          groupBy: "category",
          defaultCollapsedGroups: ["Food"],
          // A subtotal for the first column is not drawn.
          groupTotals: { item: "sum", amount: "sum" },
          groupCount: false,
        })
      )
    );
    const home = container.querySelector('tr[data-group-row="Home"]')!;
    const homeCells = [...home.querySelectorAll("td")];
    expect(homeCells).toHaveLength(3);
    expect(homeCells[0]!.getAttribute("colspan")).toBe("2");
    expect(homeCells[0]!.textContent).toBe("Home");
    expect(homeCells[1]!.textContent).toBe("$1,285.50");
    expect(homeCells[2]!.textContent).toBe("");
    // Folded: its rows are not drawn, its subtotal still is.
    expect(bodyRows().some((row) => row.textContent?.includes("Groceries"))).toBe(false);
    const food = container.querySelector('tr[data-group-row="Food"]')!;
    expect(food.querySelectorAll("td")[1]!.textContent).toBe("$310.00");
  });

  it("keeps the group count by default, and one spanning cell without subtotals", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Counted",
          rows: ENTRIES,
          rowKey: "id",
          columns: [
            { id: "item", header: "Item" },
            { id: "amount", header: "Amount" },
          ],
          groupBy: "category",
          groupTotals: { item: "sum" },
        })
      )
    );
    const home = container.querySelector('tr[data-group-row="Home"]')!;
    expect(home.querySelectorAll("td")).toHaveLength(1);
    expect(home.textContent).toBe("Home2");
  });

  it("end-aligns figure columns with tabular digits, in the cell, header and editor", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Figures",
          rows: ENTRIES,
          rowKey: "id",
          columns: [
            { id: "item", header: "Item" },
            {
              id: "amount",
              header: "Amount",
              numeric: { decimals: 2 },
              editable: true,
              editor: "number",
            },
            { id: "category", header: "Category", numeric: true, align: "start" },
          ],
        })
      )
    );
    const header = screen.getByRole("columnheader", { name: "Amount" });
    expect(header.className).toMatch(/\btext-end\b/);
    expect(header.className).toMatch(/\btabular-nums\b/);
    expect(screen.getByRole("columnheader", { name: "Item" }).className).not.toMatch(
      /\btabular-nums\b/
    );
    expect(screen.getByRole("columnheader", { name: "Category" }).className).toMatch(
      /\btext-start\b/
    );
    const refund = within(rowNamed("Refund")).getByText("\u221240.25");
    expect(refund.className).toMatch(/\btext-end\b/);
    expect(refund.className).toMatch(/\btabular-nums\b/);
    fireEvent.doubleClick(refund);
    const editor = screen.getByRole("spinbutton", { name: "Edit Amount" });
    expect(editor.className).toMatch(/\btext-end\b/);
    expect(container.querySelector("td[data-edit-cell]")).toBe(editor.closest("td"));
  });

  it("keeps the editor's type at the table's size", () => {
    render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Roomy",
          rows: ENTRIES,
          rowKey: "id",
          columns: [{ id: "item", header: "Item", editable: true }],
          density: "comfortable",
        })
      )
    );
    fireEvent.doubleClick(within(rowNamed("Rent")).getByText("Rent"));
    const editor = screen.getByRole("textbox", { name: "Edit Item" });
    expect(editor.className.split(/\s+/)).toContain("text-sm");
    expect(editor.className.split(/\s+/)).not.toContain("text-xs");
  });

  it("sets the row density and the type size", () => {
    const props = (density?: "compact" | "default" | "comfortable") => ({
      "aria-label": "Dense",
      rows: ENTRIES.slice(0, 1),
      rowKey: "id",
      columns: [{ id: "item", header: "Item" }],
      density,
    });
    const table = (density?: "compact" | "default" | "comfortable") =>
      createElement(kit.DataTable<Entry>, props(density));
    const { container, rerender } = render(inViewport(table()));
    const read = () => ({
      table: container.querySelector("table")!.className,
      th: container.querySelector("thead th")!.className,
      td: container.querySelector("tbody td")!.className,
    });
    const normal = read();
    rerender(inViewport(table("comfortable")));
    const roomy = read();
    expect(roomy.table).toMatch(/\btext-sm\b/);
    expect(normal.table).not.toMatch(/\btext-sm\b/);
    rerender(inViewport(table("compact")));
    const tight = read();
    const tokens = (className: string) => className.split(/\s+/);
    expect(tokens(tight.td)).toContain("py-1");
    expect(tokens(tight.th)).toContain("py-1");
    expect(tokens(normal.td)).not.toContain("py-1");
    // A value the kit does not know is ignored, as untyped plugin code may pass one.
    rerender(
      inViewport(createElement(kit.DataTable<Entry>, Object.assign(props(), { density: "huge" })))
    );
    expect(read()).toEqual(normal);
  });

  it("draws rules between rows and stripes every other one", () => {
    const { container } = render(
      createElement(kit.DataTable<Entry>, {
        "aria-label": "Ruled",
        rows: ENTRIES,
        rowKey: "id",
        columns: [
          { id: "item", header: "Item" },
          { id: "amount", header: "Amount" },
        ],
        virtualize: false,
        stickyFirstColumn: true,
        rowDividers: true,
        striped: true,
      })
    );
    const rows = bodyRows(container);
    const ruled = rows.map((row) => row.querySelector("td")!.className.includes("border-t"));
    expect(ruled).toEqual([false, true, true, true]);
    const striped = rows.map((row) => row.hasAttribute("data-striped"));
    expect(striped).toEqual([false, true, false, true]);
    expect(rows[1]!.querySelectorAll("td")[1]!.className).toMatch(/\bbg-overlay-subtle\b/);
    expect(rows[0]!.querySelectorAll("td")[1]!.className).not.toMatch(/\bbg-overlay-subtle\b/);
    cleanup();
    const { container: bare } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Bare",
          rows: ENTRIES,
          rowKey: "id",
          columns: [{ id: "item", header: "Item" }],
          rowDividers: true,
          striped: true,
        })
      )
    );
    // The basic table takes them too.
    const basic = bodyRows(bare);
    expect(basic[1]!.querySelector("td")!.className).toMatch(/\bborder-t\b/);
    expect(basic[1]!.querySelector("td")!.className).toMatch(/\bbg-overlay-subtle\b/);
    expect(basic[0]!.querySelector("td")!.className).not.toMatch(/\bborder-t\b/);
  });

  it("cues an editable cell with a pencil, and only an editable one", () => {
    const columns = [
      { id: "item", header: "Item", editable: (row: Entry) => row.id !== "e2" },
      { id: "category", header: "Category" },
    ];
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Cued",
          rows: ENTRIES,
          rowKey: "id",
          columns,
        })
      )
    );
    const cue = (name: string) => {
      const cell = within(rowNamed(name)).getByText(name).closest("td")!;
      return { cue: cell.classList.contains("kit-dt-edit"), glyph: cell.querySelector("svg") };
    };
    expect(cue("Rent").cue).toBe(true);
    expect(cue("Rent").glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(cue("Power")).toEqual({ cue: false, glyph: null });
    expect(cue("Home").cue).toBe(false);
    // The pencil lives in the cell's own padding: the column's geometry is unchanged.
    expect(screen.getByRole("columnheader", { name: "Item" }).className).not.toMatch(/\bpe-\d/);
    expect(within(rowNamed("Rent")).getByText("Rent").closest("td")!.className).not.toMatch(
      /\bpe-\d/
    );
    // Editing hides the cue.
    fireEvent.doubleClick(within(rowNamed("Rent")).getByText("Rent"));
    expect(container.querySelector("td[data-edit-cell]")?.classList.contains("kit-dt-edit")).toBe(
      false
    );
    cleanup();
    render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Uncued",
          rows: ENTRIES,
          rowKey: "id",
          columns,
          editAffordance: "none",
        })
      )
    );
    expect(cue("Rent")).toEqual({ cue: false, glyph: null });
  });

  it("scrolls a wide plain grid sideways on Left and Right where no tree step applies", () => {
    const flat = ENTRIES.slice(0, 3);
    render(
      inViewport(
        createElement(kit.DataTable<Entry>, {
          "aria-label": "Wide ledger",
          rows: flat,
          rowKey: "id",
          columns: [
            { id: "item", header: "Item", width: 400 },
            { id: "category", header: "Category", width: 400 },
          ],
          onRowClick: () => {},
          virtualize: false,
        })
      )
    );
    const grid = screen.getByRole("grid", { name: "Wide ledger" });
    const scroller =
      grid.closest<HTMLElement>(".overflow-auto, [data-kit-scroll]") ?? grid.parentElement!;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 300 });
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;

    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });

    expect(scrollBy.mock.calls).toEqual([[{ left: 40 }], [{ left: -40 }]]);
  });

  it("leaves clicks and keys on in-cell controls to the control", () => {
    for (const rich of [false, true]) {
      const onRowClick = vi.fn();
      const onDelete = vi.fn();
      const onSelectedRowKeysChange = vi.fn();
      render(
        inViewport(
          createElement(kit.DataTable<Entry>, {
            "aria-label": "Controls",
            rows: ENTRIES,
            rowKey: "id",
            columns: [
              { id: "item", header: "Item" },
              {
                id: "actions",
                header: "Actions",
                render: (row) =>
                  createElement(
                    "span",
                    null,
                    createElement(
                      "button",
                      { type: "button", onClick: () => onDelete(row.id) },
                      `Delete ${row.item}`
                    ),
                    createElement("input", { "aria-label": `Note ${row.item}` })
                  ),
              },
            ],
            onRowClick,
            ...(rich ? { selectable: true, onSelectedRowKeysChange } : {}),
          })
        )
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete Rent" }));
      expect(onDelete).toHaveBeenCalledWith("e1");
      expect(onRowClick).not.toHaveBeenCalled();
      expect(onSelectedRowKeysChange).not.toHaveBeenCalled();
      const note = screen.getByRole("textbox", { name: "Note Power" });
      fireEvent.click(note);
      const typed = fireEvent.keyDown(note, { key: "ArrowDown" });
      expect(typed).toBe(true);
      fireEvent.keyDown(note, { key: "Enter" });
      expect(onRowClick).not.toHaveBeenCalled();
      // A click on the row itself still activates it.
      fireEvent.click(within(rowNamed("Power")).getByText("Power"));
      expect(onRowClick).toHaveBeenCalledWith(ENTRIES[1], 1);
      cleanup();
    }
  });
});
