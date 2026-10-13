// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
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

const ownClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (ownClipboard) Object.defineProperty(navigator, "clipboard", ownClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
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

interface Deploy {
  id: string;
  name: string;
  env: string;
  region?: string;
  children?: Deploy[];
}

const DEPLOYS: Deploy[] = [
  { id: "d1", name: "web", env: "production", region: "iad1" },
  { id: "d2", name: "api", env: "staging", region: "sfo1" },
  {
    id: "d3",
    name: "jobs",
    env: "production",
    region: "fra1",
    children: [
      { id: "d3a", name: "jobs-canary", env: "production" },
      { id: "d3b", name: "jobs-main", env: "production" },
    ],
  },
  { id: "d4", name: "docs", env: "preview" },
];

const COLUMNS = [
  { id: "name", header: "Name" },
  { id: "env", header: "Environment" },
  { id: "region", header: "Region" },
];

const bodyRows = () =>
  screen.getAllByRole("row", { hidden: true }).filter((row) => row.closest("tbody"));

function rowNamed(name: string) {
  const row = bodyRows().find((candidate) => within(candidate).queryByText(name) !== null);
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

describe("DataTable, rich", () => {
  it("stays the basic table until a rich prop is given", () => {
    expect(usesRichDataTable({ columns: COLUMNS, rows: [] })).toBe(false);
    expect(usesRichDataTable({ columns: COLUMNS, rows: [], selectable: false })).toBe(false);
    expect(usesRichDataTable({ selectable: true })).toBe(true);
    expect(usesRichDataTable({ columns: [{ id: "a", resizable: true }] })).toBe(true);
    expect(usesRichDataTable({ columns: [{ id: "a", editable: () => true }] })).toBe(true);
  });

  it("keeps the rich table when a sizing or visibility prop is emptied", () => {
    expect(usesRichDataTable({ hiddenColumns: [] })).toBe(true);
    expect(usesRichDataTable({ hiddenColumns: ["name"] })).toBe(true);
    expect(usesRichDataTable({ columnWidths: {} })).toBe(true);
    expect(usesRichDataTable({ defaultHiddenColumns: [] })).toBe(true);
    expect(usesRichDataTable({ hiddenColumns: undefined })).toBe(false);
  });

  it("multi-selects through checkboxes, ranges and the header box", () => {
    const changes: (string | number)[][] = [];
    function Probe() {
      const [keys, setKeys] = useState<(string | number)[]>([]);
      return createElement(kit.DataTable<Deploy>, {
        "aria-label": "Deployments",
        rows: DEPLOYS,
        rowKey: "id",
        columns: COLUMNS,
        selectable: (row) => row.id !== "d4",
        selectedRowKeys: keys,
        onSelectedRowKeysChange: (next) => {
          changes.push(next);
          setKeys(next);
        },
      });
    }
    render(inViewport(createElement(Probe)));
    const grid = screen.getByRole("grid", { name: "Deployments" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    const checkCell = (name: string) => rowNamed(name).querySelector("td")!;
    fireEvent.click(checkCell("web"));
    expect(changes.at(-1)).toEqual(["d1"]);
    fireEvent.click(checkCell("jobs"), { shiftKey: true });
    expect(changes.at(-1)).toEqual(["d1", "d2", "d3"]);
    expect(rowNamed("api").getAttribute("aria-selected")).toBe("true");
    // The unselectable row draws no box and is skipped by "all".
    expect(checkCell("docs").querySelector("[data-slot=checkbox-glyph]")).toBeNull();
    const all = screen.getByRole("checkbox", { name: "Select all rows" });
    expect(all.getAttribute("data-state")).toBe("checked");
    fireEvent.click(checkCell("api"));
    expect(all.getAttribute("data-state")).toBe("indeterminate");
    fireEvent.click(all);
    expect(changes.at(-1)).toEqual(["d1", "d2", "d3"]);

    // Keyboard: Escape clears, Space toggles the cursor row, Shift+Down extends.
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(changes.at(-1)).toEqual([]);
    fireEvent.keyDown(grid, { key: "Home" });
    fireEvent.keyDown(grid, { key: " " });
    expect(changes.at(-1)).toEqual(["d1"]);
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(changes.at(-1)).toEqual(["d1", "d2"]);
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true, metaKey: true });
    expect(changes.at(-1)).toEqual(["d1", "d2", "d3"]);
  });

  it("groups rows under foldable headers with counts", () => {
    const onCollapsed = vi.fn();
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "By environment",
          rows: DEPLOYS,
          rowKey: "id",
          columns: COLUMNS,
          groupBy: "env",
          groupLabel: (key) => (key === "production" ? "Production" : key),
          onCollapsedGroupsChange: onCollapsed,
        })
      )
    );
    const grid = screen.getByRole("treegrid", { name: "By environment" });
    const groups = bodyRows().filter((row) => row.hasAttribute("data-group-row"));
    expect(groups.map((row) => row.textContent)).toEqual(["Production2", "staging1", "preview1"]);
    expect(groups[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(rowNamed("web").getAttribute("aria-level")).toBe("2");
    fireEvent.click(groups[0]!);
    expect(onCollapsed).toHaveBeenLastCalledWith(["production"]);
    expect(within(grid).queryByText("web")).toBeNull();
    // Right on a folded header opens it again.
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(onCollapsed).toHaveBeenLastCalledWith([]);
    expect(within(grid).getByText("web")).toBeTruthy();
  });

  it("selects a folded group's rows from its header, by box or Space", () => {
    const onKeys = vi.fn();
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Folded",
          rows: DEPLOYS,
          rowKey: "id",
          columns: COLUMNS,
          groupBy: "env",
          selectable: true,
          defaultCollapsedGroups: ["production"],
          onSelectedRowKeysChange: onKeys,
        })
      )
    );
    const header = bodyRows().find((row) => row.getAttribute("data-group-row") === "production")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const box = within(header).getByRole("checkbox", { name: "Select production" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(onKeys).toHaveBeenLastCalledWith(["d1", "d3"]);
    expect(header.getAttribute("aria-selected")).toBe("true");
    const grid = screen.getByRole("treegrid", { name: "Folded" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "Home" });
    fireEvent.keyDown(grid, { key: " " });
    expect(onKeys).toHaveBeenLastCalledWith([]);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands sub-rows, and loads lazy ones with a loading row and Retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fail = true;
    const loadSubRows = vi.fn((row: Deploy) =>
      fail
        ? Promise.reject(new Error("Timed out"))
        : Promise.resolve([{ id: `${row.id}-x`, name: `${row.name}-child`, env: row.env }])
    );
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Tree",
          rows: DEPLOYS,
          rowKey: "id",
          columns: COLUMNS,
          getSubRows: (row) => row.children,
          hasSubRows: (row) => row.id === "d1",
          loadSubRows,
        })
      )
    );
    const grid = screen.getByRole("treegrid", { name: "Tree" });
    expect(rowNamed("jobs").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rowNamed("jobs").querySelector("[data-tree-chevron]")!);
    expect(rowNamed("jobs-canary").getAttribute("aria-level")).toBe("2");
    expect(loadSubRows).not.toHaveBeenCalled();

    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "Home" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(loadSubRows).toHaveBeenCalledTimes(1);
    const status = () => bodyRows().find((row) => row.hasAttribute("data-status-row"));
    // The loading row shows nothing visible inside the inline gate.
    expect(status()?.getAttribute("data-status-row")).toBe("loading");
    expect(status()?.textContent).toBe("Loading…");
    expect(status()?.querySelector(".animate-spin")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(status()?.getAttribute("data-status-row")).toBe("error");
    expect(status()?.textContent).toContain("Timed out");
    fail = false;
    fireEvent.click(within(status()!).getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rowNamed("web-child").getAttribute("aria-level")).toBe("2");
    expect(loadSubRows).toHaveBeenCalledTimes(2);
  });

  it("keeps the cursor on a branch closed over it, and numbers columns logically", () => {
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Branches",
          rows: DEPLOYS,
          rowKey: "id",
          columns: [...COLUMNS.slice(0, 2), { ...COLUMNS[2]!, editable: (row) => row.id !== "d2" }],
          selectable: true,
          defaultHiddenColumns: ["env"],
          getSubRows: (row) => row.children,
          defaultExpandedRowKeys: ["d3"],
        })
      )
    );
    const grid = screen.getByRole("treegrid", { name: "Branches" });
    expect(grid.getAttribute("aria-colcount")).toBe("4");
    expect(screen.getByRole("columnheader", { name: "Region" }).getAttribute("aria-colindex")).toBe(
      "4"
    );
    expect(rowNamed("api").querySelectorAll("td")[2]!.getAttribute("aria-readonly")).toBe("true");
    expect(rowNamed("web").querySelectorAll("td")[2]!.getAttribute("aria-readonly")).toBeNull();
    act(() => grid.focus());
    // Onto the sub-row jobs-main, then close its parent from the chevron.
    const target = bodyRows().findIndex((row) => within(row).queryByText("jobs-main"));
    for (let step = 0; step < target; step += 1) fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe(rowNamed("jobs-main").id);
    fireEvent.click(rowNamed("jobs").querySelector("[data-tree-chevron]")!);
    expect(grid.getAttribute("aria-activedescendant")).toBe(rowNamed("jobs").id);
    expect(rowNamed("jobs").getAttribute("data-active")).toBe("true");
  });

  it("hides columns from the columns menu, never the last one", async () => {
    const onHidden = vi.fn();
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Cols",
          rows: DEPLOYS,
          rowKey: "id",
          columns: [...COLUMNS.slice(0, 2), { ...COLUMNS[2]!, hideable: false }],
          columnsMenu: true,
          defaultHiddenColumns: ["env"],
          onHiddenColumnsChange: onHidden,
        })
      )
    );
    expect(screen.queryByRole("columnheader", { name: "Environment" })).toBeNull();
    // The rail is the last numbered column, in the header and every row.
    const grid = screen.getByRole("table", { name: "Cols" });
    expect(grid.getAttribute("aria-colcount")).toBe("4");
    const rail = screen.getByRole("button", { name: "Columns" }).closest("th");
    expect(rail?.getAttribute("aria-colindex")).toBe("4");
    expect(rowNamed("web").lastElementChild?.getAttribute("aria-colindex")).toBe("4");
    const trigger = screen.getByRole("button", { name: "Columns" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const env = await screen.findByRole("menuitemcheckbox", { name: "Environment" });
    expect(env.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Region" }).hasAttribute("data-disabled")
    ).toBe(true);
    fireEvent.click(env);
    expect(onHidden).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("columnheader", { name: "Environment", hidden: true })).toBeTruthy();
  });

  it("resizes from the keyboard, resets on double-click, and remembers widths by key", () => {
    const onWidths = vi.fn();
    const table = () =>
      createElement(kit.DataTable<Deploy>, {
        "aria-label": "Sized",
        rows: DEPLOYS,
        rowKey: "id",
        columns: [{ id: "name", header: "Name", width: 120, resizable: true, minWidth: 100 }],
        viewStateKey: "deploys-test",
        onColumnWidthsChange: onWidths,
      });
    const { unmount } = render(inViewport(table()));
    const handle = screen.getByRole("separator", { name: /^Resize Name/ });
    expect(handle.getAttribute("aria-valuenow")).toBe("120");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidths).toHaveBeenLastCalledWith({ name: 128 });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onWidths).toHaveBeenLastCalledWith({ name: 100 });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByRole("columnheader", { name: "Name" }).style.width).toBe("132px");
    unmount();
    // The same key, remounted, comes back at the width it was left.
    render(inViewport(table()));
    expect(
      screen.getByRole("separator", { name: /^Resize Name/ }).getAttribute("aria-valuenow")
    ).toBe("132");
    fireEvent.doubleClick(screen.getByRole("separator", { name: /^Resize Name/ }));
    expect(onWidths).toHaveBeenLastCalledWith({});
  });

  it("pins the first column after the checkboxes", () => {
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Pinned",
          rows: DEPLOYS,
          rowKey: "id",
          columns: COLUMNS.map((column) => ({ ...column, width: 300 })),
          selectable: true,
          stickyFirstColumn: true,
        })
      )
    );
    const name = screen.getByRole("columnheader", { name: "Name" });
    expect(name.className).toContain("kit-dt-sticky");
    expect(name.style.left).toBe("32px");
    expect(screen.getByRole("grid", { name: "Pinned" }).style.minWidth).toBe("932px");
    const cell = rowNamed("web").querySelectorAll("td")[1]!;
    expect(cell.className).toContain("kit-dt-sticky");
  });

  it("edits cells in place: F2, Tab to the next, Escape, refusals and failed saves", async () => {
    const onCellEdit = vi.fn((_row: Deploy, column: string, value: string) =>
      column === "region" && value === "bad"
        ? Promise.reject(new Error("Unknown region"))
        : undefined
    );
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Edit",
          rows: DEPLOYS,
          rowKey: "id",
          columns: [
            {
              id: "name",
              header: "Name",
              editable: true,
              validate: (value) => (value.trim() ? null : "Name a deployment"),
            },
            { id: "env", header: "Environment" },
            { id: "region", header: "Region", editable: (row) => row.id !== "d2" },
          ],
          onCellEdit,
        })
      )
    );
    const grid = screen.getByRole("grid", { name: "Edit" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "F2" });
    const name = screen.getByRole("textbox", { name: "Edit Name" }) as HTMLInputElement;
    expect(name.value).toBe("web");
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(onCellEdit).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "web-2" } });
    fireEvent.keyDown(name, { key: "Tab" });
    expect(onCellEdit).toHaveBeenLastCalledWith(DEPLOYS[0], "name", "web-2");
    const region = screen.getByRole("textbox", { name: "Edit Region" }) as HTMLInputElement;
    expect(region.value).toBe("iad1");
    fireEvent.keyDown(region, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Edit Region" })).toBeNull();
    expect(document.activeElement).toBe(grid);

    // Enter edits; a failed save reopens the editor with the draft and the message.
    fireEvent.keyDown(grid, { key: "Enter" });
    const again = screen.getByRole("textbox", { name: "Edit Name" }) as HTMLInputElement;
    fireEvent.keyDown(again, { key: "Tab" });
    const regionAgain = screen.getByRole("textbox", { name: "Edit Region" }) as HTMLInputElement;
    fireEvent.change(regionAgain, { target: { value: "bad" } });
    fireEvent.keyDown(regionAgain, { key: "Enter" });
    expect(onCellEdit).toHaveBeenLastCalledWith(DEPLOYS[0], "region", "bad");
    const reopened = (await screen.findByRole("textbox", {
      name: "Edit Region",
    })) as HTMLInputElement;
    expect(reopened.value).toBe("bad");
    expect(reopened.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(reopened.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Unknown region"
    );
  });

  it("brings a draft back when a save throws, and leaves a newer edit alone on a late failure", async () => {
    let reject: (error: Error) => void = () => {};
    const onCellEdit = vi.fn((_row: Deploy, _column: string, value: string) => {
      if (value === "boom") throw new Error("Read-only");
      if (value === "late") {
        return new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      }
      return undefined;
    });
    render(
      inViewport(
        createElement(kit.DataTable<Deploy>, {
          "aria-label": "Saves",
          rows: DEPLOYS,
          rowKey: "id",
          columns: [
            { id: "name", header: "Name", editable: true },
            { id: "region", header: "Region", editable: true },
          ],
          onCellEdit,
        })
      )
    );
    const grid = screen.getByRole("grid", { name: "Saves" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "F2" });
    const name = () => screen.getByRole("textbox", { name: "Edit Name" }) as HTMLInputElement;
    fireEvent.change(name(), { target: { value: "boom" } });
    fireEvent.keyDown(name(), { key: "Enter" });
    expect(name().value).toBe("boom");
    expect(name().getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(name(), { target: { value: "late" } });
    fireEvent.keyDown(name(), { key: "Tab" });
    const region = screen.getByRole("textbox", { name: "Edit Region" }) as HTMLInputElement;
    fireEvent.change(region, { target: { value: "fra9" } });
    await act(async () => {
      reject(new Error("Conflict"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The region edit keeps its draft; the failure is announced.
    expect((screen.getByRole("textbox", { name: "Edit Region" }) as HTMLInputElement).value).toBe(
      "fra9"
    );
    expect(screen.getByText("Conflict")).toBeTruthy();
    // The failed cell keeps its draft, marked, until it is edited again.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit Region" }), { key: "Escape" });
    const webRow = rowNamed("late");
    expect(webRow.textContent).toContain("Not saved: Conflict");
    fireEvent.doubleClick(webRow.querySelectorAll("td")[0]!);
    const reopened = screen.getByRole("textbox", { name: "Edit Name" }) as HTMLInputElement;
    expect(reopened.value).toBe("late");
    expect(reopened.getAttribute("aria-invalid")).toBe("true");
  });

  it("leaves focus where the reader went when a save fails after they left", async () => {
    let reject: (error: Error) => void = () => {};
    render(
      inViewport(
        createElement(
          "div",
          null,
          createElement("button", { type: "button" }, "Elsewhere"),
          createElement(kit.DataTable<Deploy>, {
            "aria-label": "Away",
            rows: DEPLOYS,
            rowKey: "id",
            columns: [{ id: "name", header: "Name", editable: true }],
            onCellEdit: () =>
              new Promise<void>((_resolve, fail) => {
                reject = fail;
              }),
          })
        )
      )
    );
    const grid = screen.getByRole("grid", { name: "Away" });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: "F2" });
    const name = screen.getByRole("textbox", { name: "Edit Name" });
    fireEvent.change(name, { target: { value: "web-renamed" } });
    fireEvent.keyDown(name, { key: "Enter" });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    await act(async () => {
      reject(new Error("Conflict"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(elsewhere);
    expect(screen.queryByRole("textbox", { name: "Edit Name" })).toBeNull();
    expect(rowNamed("web-renamed").textContent).toContain("Not saved: Conflict");
  });

  it("ignores malformed rich props rather than throwing", () => {
    render(
      inViewport(
        createElement(kit.DataTable, {
          "aria-label": "Junk",
          rows: DEPLOYS,
          rowKey: "id",
          columns: [
            ...COLUMNS,
            {
              id: "bad",
              header: "Bad",
              render: () => {
                throw new Error("render boom");
              },
            },
          ],
          // Untyped JS sends anything.
          ...({
            groupBy: 42,
            selectable: "yes",
            columnsMenu: true,
            columnWidths: { name: -4, env: "wide" },
            hiddenColumns: "env",
            stickyFirstColumn: true,
            getSubRows: () => {
              throw new Error("boom");
            },
          } as object),
        })
      )
    );
    expect(screen.getByRole("columnheader", { name: "Environment" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(rowNamed("web")).toBeTruthy();
  });
});

interface Service {
  id: string;
  label: string;
  children?: Service[];
  lazy?: boolean;
}

const SERVICES: Service[] = [
  {
    id: "edge",
    label: "Edge",
    children: [
      { id: "cdn", label: "CDN" },
      { id: "waf", label: "WAF" },
    ],
  },
  { id: "core", label: "Core", lazy: true },
  { id: "data", label: "Data" },
];

describe("TreeView", () => {
  it("is an ARIA tree with expand, collapse, typeahead and activation", () => {
    const onActivate = vi.fn();
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Services",
          nodes: SERVICES.filter((service) => !service.lazy),
          onActivate,
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Services" });
    act(() => tree.focus());
    // Focus lands the cursor on the first node without selecting it.
    const first = screen.getByRole("treeitem", { name: "Edge" });
    expect(tree.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(tree, { key: "Home" });
    const edge = screen.getByRole("treeitem", { name: "Edge" });
    expect(edge.getAttribute("aria-selected")).toBe("true");
    expect(edge.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "WAF" }).getAttribute("aria-level")).toBe("2");
    fireEvent.keyDown(tree, { key: "w" });
    expect(screen.getByRole("treeitem", { name: "WAF" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith(SERVICES[0]!.children![1]);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.queryByRole("treeitem", { name: "WAF" })).toBeNull();
  });

  it("loads async children once, behind a loading row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resolve: (nodes: Service[]) => void = () => {};
    const getChildren = vi.fn((node: Service) =>
      node.lazy
        ? new Promise<Service[]>((done) => {
            resolve = done;
          })
        : node.children
    );
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Lazy",
          nodes: SERVICES,
          getChildren,
          hasChildren: (node) => node.lazy === true || (node.children?.length ?? 0) > 0,
        })
      )
    );
    expect(getChildren.mock.calls.filter(([node]) => node.lazy)).toHaveLength(0);
    fireEvent.click(screen.getByRole("treeitem", { name: "Core" }));
    expect(screen.getByRole("treeitem", { name: "Loading" })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByRole("treeitem", { name: "Loading" }).textContent).toBe("Loading…");
    await act(async () => {
      resolve([{ id: "queue", label: "Queue" }]);
      await Promise.resolve();
    });
    expect(screen.getByRole("treeitem", { name: "Queue" }).getAttribute("aria-level")).toBe("2");
    expect(getChildren.mock.calls.filter(([node]) => node.lazy)).toHaveLength(1);
  });

  it("checks with tri-state parents and selects many", () => {
    const onChecked = vi.fn();
    const onSelected = vi.fn();
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Checks",
          nodes: SERVICES.filter((service) => !service.lazy),
          checkable: true,
          selectionMode: "multiple",
          defaultExpanded: ["edge"],
          onCheckedChange: onChecked,
          onSelectedChange: onSelected,
        })
      )
    );
    const box = (name: string) =>
      screen.getByRole("treeitem", { name }).querySelector("[data-tree-check]")!;
    fireEvent.click(box("CDN"));
    expect(onChecked).toHaveBeenLastCalledWith(["cdn"]);
    expect(screen.getByRole("treeitem", { name: "Edge" }).getAttribute("aria-checked")).toBe(
      "mixed"
    );
    fireEvent.click(box("Edge"));
    expect(new Set(onChecked.mock.lastCall![0])).toEqual(new Set(["cdn", "waf", "edge"]));
    expect(screen.getByRole("treeitem", { name: "WAF" }).getAttribute("aria-checked")).toBe("true");

    const tree = screen.getByRole("tree", { name: "Checks" });
    expect(tree.getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.click(screen.getByRole("treeitem", { name: "CDN" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Data" }), { shiftKey: true });
    expect(onSelected).toHaveBeenLastCalledWith(["cdn", "waf", "data"]);
  });

  it("shows focus the way FileTree does in single mode, on the cursor row in multiple", () => {
    const { unmount } = render(
      inViewport(
        createElement(
          "div",
          null,
          createElement(kit.FileTree, {
            "aria-label": "Files",
            entries: [{ path: "a.ts", type: "file" }],
          }),
          createElement(kit.TreeView<Service>, {
            "aria-label": "Single",
            nodes: SERVICES.filter((service) => !service.lazy),
          })
        )
      )
    );
    const ringOf = (element: HTMLElement) =>
      element.className
        .split(/\s+/)
        .filter((name) => /outline/.test(name))
        .sort();
    const files = screen.getByRole("tree", { name: "Files" });
    const single = screen.getByRole("tree", { name: "Single" });
    act(() => single.focus());
    expect(ringOf(single)).toEqual(ringOf(files));
    unmount();
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Many",
          nodes: SERVICES.filter((service) => !service.lazy),
          selectionMode: "multiple",
        })
      )
    );
    const many = screen.getByRole("tree", { name: "Many" });
    act(() => many.focus());
    // The cursor can sit on an unselected row, so it carries the ring itself.
    expect(many.className).toContain("outline-hidden");
  });

  it("builds a discontiguous selection from the keyboard in multiple mode", () => {
    const onSelected = vi.fn();
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Multi",
          nodes: SERVICES.filter((service) => !service.lazy),
          selectionMode: "multiple",
          defaultExpanded: ["edge"],
          onSelectedChange: onSelected,
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Multi" });
    act(() => tree.focus());
    fireEvent.keyDown(tree, { key: "Home" });
    expect(onSelected).toHaveBeenLastCalledWith(["edge"]);
    fireEvent.keyDown(tree, { key: "End", ctrlKey: true, metaKey: true });
    expect(onSelected).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tree, { key: " ", ctrlKey: true, metaKey: true });
    expect(onSelected).toHaveBeenLastCalledWith(["edge", "data"]);
  });

  it("moves nodes with Alt+arrows, honouring canDrop", () => {
    const onMove = vi.fn();
    render(
      inViewport(
        createElement(kit.TreeView<Service>, {
          "aria-label": "Move",
          nodes: SERVICES.filter((service) => !service.lazy),
          defaultExpanded: ["edge"],
          defaultSelected: ["waf"],
          onMove,
          canDrop: (move) => !(move.id === "data" && move.parentId === "edge"),
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Move" });
    act(() => tree.focus());
    fireEvent.keyDown(tree, { key: "ArrowUp", altKey: true });
    expect(onMove).toHaveBeenLastCalledWith({
      id: "waf",
      parentId: "edge",
      index: 0,
      fromParentId: "edge",
      fromIndex: 1,
    });
    fireEvent.keyDown(tree, { key: "ArrowLeft", altKey: true });
    expect(onMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "waf", parentId: null, index: 1 })
    );
    expect(document.querySelector("[data-tree-announcer]")?.textContent).toBe(
      "Moved WAF to the top level, position 2."
    );
    // Data into Edge (the sibling above it) is refused by canDrop; Data up is not.
    onMove.mockClear();
    fireEvent.keyDown(tree, { key: "End" });
    fireEvent.keyDown(tree, { key: "ArrowRight", altKey: true });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "ArrowUp", altKey: true });
    expect(onMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "data", parentId: null, index: 0 })
    );
  });
});

describe("ObjectInspector", () => {
  const response = {
    id: "dep_42",
    ready: true,
    replicas: 3,
    owner: null,
    url: "https://example.test/" + "a".repeat(40),
    meta: { region: "iad1", tags: ["web", "edge"] },
    events: Array.from({ length: 120 }, (_, index) => ({ seq: index })),
  };

  it("draws typed values, opens to depth, expands all and filters", () => {
    render(
      inViewport(
        createElement(kit.ObjectInspector, {
          "aria-label": "Response",
          value: response,
          name: "deployment",
          maxStringLength: 30,
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Response" });
    const item = (label: RegExp) => within(tree).getByRole("treeitem", { name: label });
    expect(item(/^ready: true$/).querySelector(".text-category-purple")).toBeTruthy();
    expect(item(/^replicas: 3$/).querySelector(".text-syntax-number")).toBeTruthy();
    expect(item(/^id: "dep_42"$/).querySelector(".text-syntax-string")).toBeTruthy();
    expect(item(/^meta: \{2 keys\}$/).getAttribute("aria-expanded")).toBe("false");
    // A long string is cut with a "more" toggle.
    const url = item(/^url:/);
    fireEvent.click(within(url).getByRole("button", { name: "more" }));
    expect(item(/^url:/).textContent).toContain("a".repeat(40));
    // A 120-item array opens into ranges.
    fireEvent.click(item(/^events:/).querySelector("[data-tree-chevron]")!);
    expect(within(tree).getByRole("treeitem", { name: /^\[100 … 119\]/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(item(/^region: "iad1"$/).getAttribute("aria-level")).toBe("3");
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter Response" }), {
      target: { value: "edge" },
    });
    const names = within(tree)
      .getAllByRole("treeitem")
      .map((row) => row.getAttribute("aria-label"));
    expect(names).toEqual([
      "deployment: {7 keys}",
      "meta: {2 keys}",
      "tags: Array(2)",
      '1: "edge"',
    ]);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Response" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText('Nothing matches "zzz"')).toBeTruthy();
  });

  it("copies the cursor row's value with Cmd+C and its path from the menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      inViewport(
        createElement(kit.ObjectInspector, {
          "aria-label": "Copy",
          value: response,
          name: "deployment",
          toolbar: false,
        })
      )
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    const tree = screen.getByRole("tree", { name: "Copy" });
    act(() => tree.focus());
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", metaKey: true, ctrlKey: true });
    expect(writeText).toHaveBeenLastCalledWith("dep_42");
    fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: /^meta:/ }), {
      clientX: 4,
      clientY: 4,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenLastCalledWith("deployment.meta");
  });
});

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
  const bodyRows = (root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLElement>("tbody tr")].filter((row) => row.querySelector("td"));

  function rowNamed(name: string) {
    const row = bodyRows().find((candidate) => within(candidate).queryByText(name));
    if (!row) throw new Error(`no row ${name}`);
    return row;
  }

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
