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
    const box = header.querySelector("[data-slot=checkbox-glyph]")!;
    fireEvent.click(box.parentElement!);
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
    fireEvent.keyDown(tree, { key: "ArrowDown" });
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
