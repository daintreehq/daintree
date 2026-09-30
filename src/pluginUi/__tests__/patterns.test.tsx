// @vitest-environment jsdom
import { createElement, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
// Evaluated up front so the kit's lazy chunk resolves before the first render
// suspends on it, as it does in the app once a view has imported the kit.
import "@/components/PluginKit/PluginKit";

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

afterEach(cleanup);

// jsdom has no layout, so the virtualiser is handed a 300px viewport of 30px rows.
function inViewport(children: ReactNode) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight: 300, itemHeight: 30 } },
    children
  );
}

function renderLoose<P extends object>(component: ComponentType<P>, looseProps: string) {
  const props: P = JSON.parse(looseProps);
  return render(createElement(component, props));
}

const TEN_THOUSAND = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}` }));

describe("@daintreehq/plugin-ui 1.1 lists", () => {
  it("mounts only the visible window of a 10k-item VirtualList", () => {
    const { container } = render(
      inViewport(
        createElement(kit.VirtualList<{ id: string; name: string }>, {
          items: TEN_THOUSAND,
          "aria-label": "Rows",
          itemKey: (_index, item) => item?.id ?? "",
          renderItem: (_index, item) => createElement("span", { "data-row": "" }, item?.name),
        })
      )
    );
    const rows = container.querySelectorAll("[data-row]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]?.textContent).toBe("Row 0");
    const list = screen.getByRole("list", { name: "Rows" });
    expect(list.querySelectorAll("[role='listitem']").length).toBe(rows.length);
  });

  it("renders a count-only VirtualList by index", () => {
    const { container } = render(
      inViewport(
        createElement(kit.VirtualList, {
          count: 5000,
          "aria-label": "Indexed",
          renderItem: (index) => createElement("span", { "data-row": "" }, `#${index}`),
        })
      )
    );
    expect(container.querySelectorAll("[data-row]").length).toBeLessThan(100);
  });

  it("makes a keyboard listbox from useListNavigation, VirtualList and ListRow", () => {
    const onSelect = vi.fn();
    function Picker() {
      const nav = kit.useListNavigation({
        count: TEN_THOUSAND.length,
        onSelect,
        getLabel: (index) => TEN_THOUSAND[index]?.name ?? "",
      });
      return createElement(kit.VirtualList<{ id: string; name: string }>, {
        ...nav.containerProps,
        activeIndex: nav.activeIndex,
        items: TEN_THOUSAND,
        "aria-label": "Pick a row",
        renderItem: (index, item) =>
          createElement(kit.ListRow, { ...nav.getRowProps(index), title: item?.name ?? "" }),
      });
    }
    render(inViewport(createElement(Picker)));
    const listbox = screen.getByRole("listbox", { name: "Pick a row" });
    expect(listbox.getAttribute("tabindex")).toBe("0");
    // The keyboard lives on the viewport-sized scroller, so the global focus
    // ring frames what is visible instead of the full, clipped row stack.
    expect(listbox.hasAttribute("data-virtuoso-scroller")).toBe(true);
    expect(listbox.className).toContain("focus-visible:-outline-offset-2");
    const first = screen.getAllByRole("option")[0]!;
    expect(listbox.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    const second = screen.getAllByRole("option")[1]!;
    expect(listbox.getAttribute("aria-activedescendant")).toBe(second.id);
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    fireEvent.keyDown(listbox, { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("skips disabled rows and never selects one from the keyboard or a click", () => {
    const onSelect = vi.fn();
    const labels = ["Alpha", "Beta", "Bravo", "Charlie"];
    const disabled = new Set([0, 1]);
    let result: ReturnType<typeof kit.useListNavigation> | undefined;
    function Picker() {
      result = kit.useListNavigation({
        count: labels.length,
        onSelect,
        getLabel: (i) => labels[i]!,
        isDisabled: (i) => disabled.has(i),
      });
      return createElement(
        "div",
        { ...result.containerProps, "data-testid": "list" },
        labels.map((label, i) =>
          createElement(kit.ListRow, { key: label, ...result!.getRowProps(i), title: label })
        )
      );
    }
    render(createElement(Picker));
    const list = screen.getByTestId("list");
    const options = screen.getAllByRole("option");
    expect(options[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(options[2]!.getAttribute("aria-disabled")).toBeNull();

    // The initial index is disabled, so the cursor starts on the first enabled row.
    expect(result?.activeIndex).toBe(2);
    expect(list.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
    fireEvent.click(options[1]!);
    expect(onSelect).not.toHaveBeenCalled();
    act(() => result!.setActiveIndex(1));
    expect(result?.activeIndex).toBe(2);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(result?.activeIndex).toBe(3);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(result?.activeIndex).toBe(2);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(result?.activeIndex).toBe(2);
    fireEvent.keyDown(list, { key: "Home" });
    expect(result?.activeIndex).toBe(2);
    fireEvent.keyDown(list, { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(list, { key: "End" });
    expect(result?.activeIndex).toBe(3);
    // Typeahead passes over the disabled "Alpha" and "Beta".
    fireEvent.keyDown(list, { key: "a" });
    expect(result?.activeIndex).toBe(3);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith(3);
  });

  it("never selects in a list whose rows are all disabled", () => {
    const onSelect = vi.fn();
    let result: ReturnType<typeof kit.useListNavigation> | undefined;
    function Probe() {
      result = kit.useListNavigation({ count: 3, onSelect, isDisabled: () => true });
      return createElement("div", { ...result.containerProps, "data-testid": "all-off" });
    }
    render(createElement(Probe));
    const list = screen.getByTestId("all-off");
    expect(result?.activeIndex).toBe(-1);
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    for (const key of ["ArrowDown", "End", "Enter", " "]) fireEvent.keyDown(list, { key });
    expect(result?.activeIndex).toBe(-1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("wraps, clamps and typeaheads in useListNavigation", () => {
    let result: ReturnType<typeof kit.useListNavigation> | undefined;
    const labels = ["Alpha", "Beta", "Bravo", "Charlie"];
    function Probe({ loop }: { loop: boolean }) {
      result = kit.useListNavigation({ count: labels.length, loop, getLabel: (i) => labels[i]! });
      return createElement("div", { ...result.containerProps, "data-testid": "list" });
    }
    const { rerender } = render(createElement(Probe, { loop: false }));
    const list = screen.getByTestId("list");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(result?.activeIndex).toBe(0);
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(result?.activeIndex).toBe(3);
    rerender(createElement(Probe, { loop: true }));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(result?.activeIndex).toBe(0);
    fireEvent.keyDown(list, { key: "b" });
    expect(result?.activeIndex).toBe(1);
    fireEvent.keyDown(list, { key: "b" });
    expect(result?.activeIndex).toBe(2);
  });

  it("virtualises a 10k-row DataTable and reports sorting", () => {
    const onSortChange = vi.fn();
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<{ id: string; name: string }>, {
          "aria-label": "People",
          rows: TEN_THOUSAND,
          rowKey: "id",
          columns: [
            { id: "name", header: "Name", sortable: true },
            { id: "id", header: "Id", width: 80, align: "end" },
          ],
          sort: { columnId: "name", direction: "asc" },
          onSortChange,
        })
      )
    );
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBeGreaterThan(0);
    expect(bodyRows.length).toBeLessThan(100);
    expect(bodyRows[0]?.textContent).toBe("Row 0r0");
    const table = screen.getByRole("table", { name: "People" });
    expect(table.getAttribute("aria-rowcount")).toBe("10001");
    const header = screen.getByRole("columnheader", { name: "Name" });
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenCalledWith({ columnId: "name", direction: "desc" });
  });

  it("makes a DataTable with onRowClick a keyboard grid", () => {
    const onRowClick = vi.fn();
    render(
      inViewport(
        createElement(kit.DataTable<{ id: string; name: string }>, {
          "aria-label": "Pick",
          rows: TEN_THOUSAND.slice(0, 50),
          rowKey: (row) => row.id,
          selectedRowKey: "r2",
          columns: [{ id: "name", header: "Name", render: (row) => `* ${row.name}` }],
          onRowClick,
        })
      )
    );
    const grid = screen.getByRole("grid", { name: "Pick" });
    act(() => grid.focus());
    const rows = screen.getAllByRole("row");
    // Header row first; the cursor starts on the first body row.
    expect(grid.getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
    // The cursor row is the grid's focus indicator, owned by the grid's own
    // :focus-visible so it shows only while the keyboard is there.
    expect(rows[1]!.getAttribute("data-active")).toBe("true");
    expect(grid.className).toContain("focus-visible:[&_tr[data-active=true]]:outline-2");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(TEN_THOUSAND[1], 1);
    expect(rows[3]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[3]!.textContent).toBe("* Row 2");
    fireEvent.click(rows[5]!);
    expect(onRowClick).toHaveBeenLastCalledWith(TEN_THOUSAND[4], 4);
    // Enter on a header control belongs to that control, not the grid cursor.
    onRowClick.mockClear();
    fireEvent.keyDown(screen.getByRole("columnheader", { name: "Name" }), { key: "Enter" });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("shows `empty` in place of an empty DataTable", () => {
    render(
      createElement(kit.DataTable, {
        "aria-label": "None",
        rows: [],
        rowKey: "id",
        columns: [{ id: "name", header: "Name" }],
        empty: createElement(kit.EmptyState, { title: "No matches", variant: "filtered-empty" }),
      })
    );
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("bounds a 20k-line LogView to maxLines and the visible window", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const { container } = render(
      inViewport(
        createElement(kit.LogView, {
          lines: [...lines, { text: "boom", severity: "error" }],
          maxLines: 1000,
          follow: false,
          "aria-label": "Job output",
        })
      )
    );
    const log = screen.getByRole("log", { name: "Job output" });
    expect(log.getAttribute("aria-live")).toBe("off");
    const rendered = container.querySelectorAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    // Oldest dropped: the view starts 1,001 lines from the end.
    expect(rendered[0]?.textContent).toBe("line 19001");
  });

  it("ignores junk list props from untyped JS", () => {
    const { container } = renderLoose(
      kit.LogView,
      JSON.stringify({ lines: "not an array", maxLines: -3, "aria-label": 7 })
    );
    expect(container.querySelector("[role='log']")).not.toBeNull();
  });
});

describe("@daintreehq/plugin-ui 1.1 pane chrome and states", () => {
  it("renders a PaneHeader with a roving Toolbar of ToolbarButtons", () => {
    const onRefresh = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.PaneHeader, {
          title: "Issues",
          icon: "list",
          subtitle: "12 open",
          actions: createElement(
            kit.Toolbar,
            { "aria-label": "Issue actions" },
            createElement(kit.ToolbarButton, {
              icon: "refresh",
              "aria-label": "Refresh",
              onClick: onRefresh,
            }),
            createElement(kit.ToolbarButton, { icon: "filter", label: "Filter", pressed: true }),
            createElement(kit.ToolbarButton, { icon: "x", "aria-label": "Clear", disabled: true })
          ),
        })
      )
    );
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    expect(screen.getByText("12 open")).toBeTruthy();
    const toolbar = screen.getByRole("toolbar", { name: "Issue actions" });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    const filter = screen.getByRole("button", { name: "Filter" });
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(refresh.tabIndex).toBe(0);
    expect(filter.tabIndex).toBe(-1);
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    act(() => refresh.focus());
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(filter);
    fireEvent.click(clear);
    expect(clear.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders PaneState empty and error, with Retry", () => {
    const onRetry = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(kit.PaneState, { kind: "empty", title: "No issues", icon: "inbox" }),
        createElement(kit.PaneState, {
          kind: "error",
          title: "Couldn't load issues",
          description: "The server said no",
          onRetry,
        })
      )
    );
    expect(screen.getByRole("status").textContent).toContain("No issues");
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load issues");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("holds a loading PaneState back behind the Doherty gate", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        createElement(kit.PaneState, { kind: "loading", title: "Loading issues" })
      );
      expect(container.querySelector(".animate-spin")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(container.querySelector(".animate-spin")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the severity glyph set", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(kit.SeverityIcon, { severity: "error", "aria-label": "Failed" }),
        createElement(kit.SeverityIcon, { severity: "warning" }),
        createElement(kit.SeverityIcon, { severity: "danger", size: 12 }),
        createElement(kit.SeverityIcon, { severity: "success" }),
        createElement(kit.SeverityIcon, { severity: "info" }),
        // @ts-expect-error an unknown severity falls back to neutral
        createElement(kit.SeverityIcon, { severity: "catastrophic" })
      )
    );
    expect(screen.getByRole("img", { name: "Failed" }).getAttribute("class")).toContain(
      "text-status-danger"
    );
    const glyphs = container.querySelectorAll("svg");
    expect(glyphs.length).toBe(6);
    expect(glyphs[2]?.getAttribute("width")).toBe("12");
    expect(glyphs[2]?.getAttribute("class")).toContain("lucide-octagon-alert");
    expect(glyphs[5]?.getAttribute("class")).toContain("text-text-secondary");
  });
});

describe("@daintreehq/plugin-ui 1.1 forms and settings", () => {
  it("wires a FormField's label, description and error to kit controls", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.FormField, {
          label: "Title",
          description: "Shown in the list",
          error: "Required",
          required: true,
          children: createElement(kit.Input, { value: "", onValueChange: () => {} }),
        }),
        createElement(kit.FormField, {
          label: "Priority",
          children: createElement(kit.Select, { options: [{ value: "p1", label: "P1" }] }),
        }),
        createElement(kit.FormField, {
          label: "Own control",
          htmlFor: "mine",
          children: createElement("input", { id: "mine" }),
        }),
        createElement(kit.FormField, {
          label: "Due date",
          error: "Pick a weekday",
          children: (control) => createElement("input", { ...control, type: "date" }),
        })
      )
    );
    const input = screen.getByRole("textbox", { name: "Title" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Required",
      "Shown in the list",
    ]);
    expect(screen.getByRole("combobox", { name: "Priority" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Own control" })).toBeTruthy();
    const due = screen.getByLabelText("Due date");
    expect(due.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(due.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Pick a weekday"
    );
  });

  it("toggles a Switch with a boolean", () => {
    const onCheckedChange = vi.fn();
    render(createElement(kit.Switch, { "aria-label": "Auto refresh", onCheckedChange }));
    fireEvent.click(screen.getByRole("switch", { name: "Auto refresh" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Auto refresh" }));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("draws the app's one switch, keeping a plugin's DOM props and ignoring size", () => {
    const onFocus = vi.fn();
    render(
      createElement(kit.Switch, {
        "aria-label": "Sync",
        defaultChecked: true,
        size: "sm",
        "data-kind": "sync",
        onFocus,
      })
    );
    const toggle = screen.getByRole("switch", { name: "Sync" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-size")).toBe("md");
    expect(toggle.getAttribute("data-kind")).toBe("sync");
    fireEvent.focus(toggle);
    expect(onFocus).toHaveBeenCalled();
  });

  it("switches Tabs and renders the active panel", () => {
    function View() {
      const [tab, setTab] = useState("open");
      return createElement(kit.Tabs, {
        "aria-label": "Issue lists",
        value: tab,
        onValueChange: setTab,
        items: [
          { value: "open", label: "Open", badge: 1234 },
          { value: "closed items", label: "Closed", icon: "check" },
        ],
        content: { open: "Open list", "closed items": "Closed list" },
      });
    }
    render(createElement(View));
    const open = screen.getByRole("tab", { name: /Open/ });
    expect(open.textContent).toContain("1.2k");
    expect(screen.getByRole("tabpanel").textContent).toBe("Open list");
    act(() => open.focus());
    fireEvent.keyDown(open, { key: "ArrowRight" });
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toBe("Closed list");
    const closed = screen.getByRole("tab", { name: "Closed" });
    expect(closed.getAttribute("aria-selected")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe(closed.id);
    expect(closed.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("maps ProgressBar 0..1 onto the host bar and drops a bad value to indeterminate", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.ProgressBar, { value: 0.42, label: "Indexing" }),
        renderLooseElement(kit.ProgressBar, { value: "half", label: "Syncing" })
      )
    );
    expect(
      screen.getByRole("progressbar", { name: "Indexing" }).getAttribute("aria-valuenow")
    ).toBe("42");
    expect(screen.getByRole("progressbar", { name: "Syncing" }).hasAttribute("aria-valuenow")).toBe(
      false
    );
  });

  it("builds a settings view from Section, Group, Row and Actions", () => {
    const onReset = vi.fn();
    render(
      createElement(
        kit.SettingsSection,
        { title: "Sync", description: "How the plugin talks to the server" },
        createElement(
          kit.SettingsGroup,
          null,
          createElement(kit.SettingsRow, {
            label: "Auto refresh",
            description: "Every 5 minutes",
            isModified: true,
            onReset,
            control: (ids) =>
              createElement(kit.Switch, {
                "aria-labelledby": ids.labelId,
                "aria-describedby": ids.descriptionId,
              }),
          }),
          createElement(
            kit.SettingsActions,
            { status: "Saved" },
            createElement(kit.Button, { variant: "contrast", size: "sm" }, "Save")
          )
        )
      )
    );
    expect(screen.getByRole("group", { name: "Sync" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Auto refresh" });
    expect(document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Every 5 minutes"
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Auto refresh to default" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("renders a ListRow as a button with onSelect and marks the selected record", () => {
    const onSelect = vi.fn();
    render(
      createElement(kit.ListRow, {
        title: "fix: crash",
        subtitle: "#42",
        meta: "2h",
        icon: "git-branch",
        selected: true,
        onSelect,
      })
    );
    const row = screen.getByRole("button", { name: /fix: crash/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("data-selected")).toBe("true");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

function renderLooseElement<P extends object>(component: ComponentType<P>, loose: object) {
  const props: P = JSON.parse(JSON.stringify(loose));
  return createElement(component, props);
}
