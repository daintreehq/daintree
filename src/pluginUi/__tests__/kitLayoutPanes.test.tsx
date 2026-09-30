// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import {
  groupOffsets,
  readSplitPanes,
  taskNews,
  taskSummary,
} from "@/components/PluginKit/PluginKitLayoutPanes";
import { TooltipProvider } from "@/components/ui/tooltip";

// A ResizeObserver that reports when the test says the layout changed.
const resizeCallbacks = new Set<() => void>();
class ManualResizeObserver {
  private readonly callback: () => void;
  constructor(callback: (entries: unknown[]) => void) {
    this.callback = () => callback([]);
  }
  observe() {
    resizeCallbacks.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
}

function relayout() {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback();
  });
}

// jsdom computes no geometry: elements report the size a test assigns to a
// marker attribute they carry, and 0 otherwise.
const sizes = new Map<string, { width: number; height: number }>();
const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");

function sizeOf(element: HTMLElement) {
  for (const [attribute, size] of sizes) {
    if (element.hasAttribute(attribute)) return size;
  }
  return { width: 0, height: 0 };
}

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function rect(this: HTMLElement) {
      const { width, height } = sizeOf(this);
      return DOMRect.fromRect({ x: 0, y: 0, width, height });
    },
  });
});

afterEach(() => {
  cleanup();
  sizes.clear();
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ownRect) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", ownRect);
});

function wrap(element: ReactNode) {
  return (
    <TooltipProvider>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 28 }}>
        {element}
      </VirtuosoMockContext.Provider>
    </TooltipProvider>
  );
}

function mount(element: ReactNode) {
  const view = render(wrap(element));
  return { ...view, update: (next: ReactNode) => view.rerender(wrap(next)) };
}

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function styleSize(element: HTMLElement, axis: "width" | "height"): number {
  return Number.parseFloat(element.style[axis]);
}

describe("MasterDetail", () => {
  function Harness({ initial = null as string | null }: { initial?: string | null }) {
    const [selected, setSelected] = useState<string | null>(initial);
    return (
      <kit.MasterDetail
        data-testid="md"
        selectedId={selected}
        onBack={() => setSelected(null)}
        listLabel="Issues"
        detailLabel="Issue"
        detailTitle="Fix the flaky test"
        list={
          <button type="button" onClick={() => setSelected("42")}>
            Open 42
          </button>
        }
        detail={<p>Detail of {selected ?? "nothing"}</p>}
      />
    );
  }

  it("shows both panes and a divider when wide", () => {
    sizes.set("data-master-detail", { width: 900, height: 600 });
    mount(<Harness initial="42" />);
    relayout();
    expect(screen.getByTestId("md").getAttribute("data-master-detail")).toBe("split");
    expect(screen.getByRole("region", { name: "Issues" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Issue" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: /resize issues/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("narrow, swaps list for detail on selection and back again, keeping focus", () => {
    sizes.set("data-master-detail", { width: 400, height: 600 });
    mount(<Harness />);
    relayout();
    const root = screen.getByTestId("md");
    expect(root.getAttribute("data-master-detail")).toBe("list");
    const open = screen.getByRole("button", { name: "Open 42" });
    open.focus();
    fireEvent.click(open);
    expect(root.getAttribute("data-master-detail")).toBe("detail");
    const back = screen.getByRole("button", { name: "Back" });
    expect(document.activeElement).toBe(back);
    expect(screen.getByText("Fix the flaky test")).toBeTruthy();
    fireEvent.click(back);
    expect(root.getAttribute("data-master-detail")).toBe("list");
    // Focus goes back to the row that opened the record.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open 42" }));
  });

  it("hands focus to the detail when widening takes the Back strip away", () => {
    sizes.set("data-master-detail", { width: 400, height: 600 });
    mount(<Harness />);
    relayout();
    fireEvent.click(screen.getByRole("button", { name: "Open 42" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
    sizes.set("data-master-detail", { width: 900, height: 600 });
    relayout();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Issue" }));
  });

  it("keeps both panes mounted across the breakpoint", () => {
    sizes.set("data-master-detail", { width: 900, height: 600 });
    mount(<Harness initial="7" />);
    relayout();
    const detail = screen.getByText("Detail of 7");
    sizes.set("data-master-detail", { width: 400, height: 600 });
    relayout();
    expect(screen.getByTestId("md").getAttribute("data-master-detail")).toBe("detail");
    expect(screen.getByText("Detail of 7")).toBe(detail);
  });

  it("remembers the list width under persistKey", () => {
    sizes.set("data-master-detail", { width: 900, height: 600 });
    const view = mount(
      <kit.MasterDetail list="L" detail="D" persistKey="md-test" defaultListSize={300} />
    );
    relayout();
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("310");
    view.unmount();
    mount(<kit.MasterDetail list="L" detail="D" persistKey="md-test" defaultListSize={300} />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("310");
  });

  it("ignores a selectedId that is not a string or number", () => {
    sizes.set("data-master-detail", { width: 400, height: 600 });
    mount(untyped("MasterDetail", { list: "L", detail: "D", selectedId: {}, "data-testid": "md" }));
    relayout();
    expect(screen.getByTestId("md").getAttribute("data-master-detail")).toBe("list");
  });
});

describe("SplitGroup", () => {
  it("resolves the filling pane and drops panes without a unique id", () => {
    const panes = readSplitPanes([
      { id: "a", content: "A", defaultSize: 200 },
      { id: "b", content: "B" },
      { id: "b", content: "dup" },
      { content: "no id" },
      { id: "c", content: "C", defaultSize: 300, collapsible: true },
    ]);
    expect(panes.map((pane) => pane.id)).toEqual(["a", "b", "c"]);
    expect(panes.map((pane) => pane.fill)).toEqual([false, true, false]);
    // A filling pane never collapses and has no floor unless given one.
    expect(readSplitPanes([{ id: "x", fill: true, collapsible: true }])[0]).toMatchObject({
      fill: true,
      collapsible: false,
      min: 0,
    });
    // With every pane sized, the last one fills.
    expect(
      readSplitPanes([
        { id: "a", defaultSize: 100 },
        { id: "b", defaultSize: 100 },
      ]).map((pane) => pane.fill)
    ).toEqual([false, true]);
  });

  it("puts one handle on each boundary, facing the filling pane", () => {
    mount(
      <kit.SplitGroup
        panes={[
          { id: "nav", content: "Nav", defaultSize: 200, handleLabel: "Resize nav" },
          { id: "main", content: "Main" },
          {
            id: "inspector",
            content: "Inspector",
            defaultSize: 280,
            handleLabel: "Resize inspector",
          },
        ]}
      />
    );
    const handles = screen.getAllByRole("separator");
    expect(handles.map((handle) => handle.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Resize nav/),
      expect.stringMatching(/^Resize inspector/),
    ]);
    const nav = document.querySelector<HTMLElement>('[data-split-group-pane="nav"]')!;
    const inspector = document.querySelector<HTMLElement>('[data-split-group-pane="inspector"]')!;
    // Before the fill, the arrow away from it grows; after it, the other way.
    fireEvent.keyDown(handles[0]!, { key: "ArrowRight" });
    expect(styleSize(nav, "width")).toBe(210);
    fireEvent.keyDown(handles[1]!, { key: "ArrowLeft" });
    expect(styleSize(inspector, "width")).toBe(290);
    fireEvent.keyDown(handles[1]!, { key: "ArrowUp" });
    expect(styleSize(inspector, "width")).toBe(290);
  });

  it("collapses a collapsible pane from its handle and reports it", () => {
    const onCollapsedChange = vi.fn();
    const onLayoutChange = vi.fn();
    mount(
      <kit.SplitGroup
        panes={[
          { id: "main", content: "Main" },
          { id: "inspector", content: "Inspector", defaultSize: 280, collapsible: true },
        ]}
        onCollapsedChange={onCollapsedChange}
        onLayoutChange={onLayoutChange}
      />
    );
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "Enter" });
    const pane = document.querySelector<HTMLElement>('[data-split-group-pane="inspector"]')!;
    expect(pane.getAttribute("data-collapsed")).toBe("true");
    expect(handle.getAttribute("aria-valuetext")).toBe("Collapsed");
    expect(onCollapsedChange).toHaveBeenLastCalledWith(["inspector"]);
    expect(onLayoutChange).toHaveBeenLastCalledWith({ sizes: {}, collapsed: ["inspector"] });
    // Shrinking a folded pane does nothing; growing it brings it back at its size.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(pane.getAttribute("data-collapsed")).toBe("true");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(pane.getAttribute("data-collapsed")).toBeNull();
    expect(styleSize(pane, "width")).toBe(280);
  });

  it("follows a controlled collapsed list", () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState<string[]>(["side"]);
      return (
        <>
          <button type="button" onClick={() => setCollapsed([])}>
            Show side
          </button>
          <kit.SplitGroup
            orientation="vertical"
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            panes={[
              { id: "top", content: "Top" },
              { id: "side", content: "Side", defaultSize: 160, collapsible: true },
            ]}
          />
        </>
      );
    }
    mount(<Harness />);
    const pane = document.querySelector<HTMLElement>('[data-split-group-pane="side"]')!;
    expect(pane.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show side" }));
    expect(pane.getAttribute("data-collapsed")).toBeNull();
    expect(styleSize(pane, "height")).toBe(160);
  });

  it("caps a pane at the room the group leaves", () => {
    sizes.set("data-split-group", { width: 700, height: 400 });
    mount(
      <kit.SplitGroup
        panes={[
          { id: "a", content: "A", defaultSize: 200, maxSize: 5000 },
          { id: "b", content: "B", minSize: 200 },
          { id: "c", content: "C", defaultSize: 200 },
        ]}
      />
    );
    relayout();
    const first = screen.getAllByRole("separator")[0]!;
    fireEvent.keyDown(first, { key: "End" });
    // 700 − the fill's 200 floor − c's 200 − two 6px tracks.
    expect(first.getAttribute("aria-valuenow")).toBe("288");
  });

  it("reads no size off the prototype for an id like constructor", () => {
    mount(
      <kit.SplitGroup
        panes={[
          { id: "main", content: "M" },
          { id: "constructor", content: "C", defaultSize: 200 },
        ]}
      />
    );
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("210");
  });

  it("keeps a reset and an unfold inside the room the group leaves", () => {
    sizes.set("data-split-group", { width: 500, height: 400 });
    mount(
      <kit.SplitGroup
        panes={[
          { id: "main", content: "M", minSize: 200 },
          { id: "side", content: "S", defaultSize: 400, minSize: 100, collapsible: true },
        ]}
      />
    );
    relayout();
    const handle = screen.getByRole("separator");
    // 500 − the fill's 200 floor − one 6px track.
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("294");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(handle.getAttribute("aria-valuetext")).toBe("Collapsed");
    // End on a folded pane takes the largest size, not the remembered one.
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("294");
  });

  it("remembers a pane dragged to a zero floor", () => {
    const panes = [
      { id: "main", content: "M" },
      { id: "side", content: "S", defaultSize: 200, minSize: 0 },
    ];
    const view = mount(<kit.SplitGroup panes={panes} persistKey="sg-zero" />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    view.unmount();
    mount(<kit.SplitGroup panes={panes} persistKey="sg-zero" />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("0");
  });

  it("restores sizes remembered under persistKey", () => {
    const panes = [
      { id: "list", content: "List", defaultSize: 240 },
      { id: "rest", content: "Rest" },
    ];
    const view = mount(<kit.SplitGroup panes={panes} persistKey="sg-test" />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight", shiftKey: true });
    view.unmount();
    mount(<kit.SplitGroup panes={panes} persistKey="sg-test" />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("290");
  });
});

describe("Inspector and PropertyRow", () => {
  it("labels a kit control in the row and draws read-only values", () => {
    mount(
      <kit.Inspector aria-label="Issue properties">
        <kit.InspectorSection title="Details">
          <kit.PropertyRow label="Title">
            <kit.Input value="Flaky test" onChange={() => {}} />
          </kit.PropertyRow>
          <kit.PropertyRow label="Number">#4211</kit.PropertyRow>
          <kit.PropertyRow label="Milestone" />
        </kit.InspectorSection>
      </kit.Inspector>
    );
    expect(screen.getByRole("region", { name: "Issue properties" })).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Flaky test");
    expect(screen.getByText("#4211")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("folds a section from its heading, and draws no button for a fixed one", () => {
    const onOpenChange = vi.fn();
    mount(
      <kit.Inspector>
        <kit.InspectorSection title="Labels" onOpenChange={onOpenChange}>
          <kit.PropertyRow label="Type">Bug</kit.PropertyRow>
        </kit.InspectorSection>
        <kit.InspectorSection title="Fixed" collapsible={false}>
          <kit.PropertyRow label="Kind">Static</kit.PropertyRow>
        </kit.InspectorSection>
      </kit.Inspector>
    );
    const toggle = screen.getByRole("button", { name: "Labels" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Folded rows stay mounted but hidden, so the heading always controls something.
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(body.hidden).toBe(true);
    expect(body.textContent).toContain("Bug");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("button", { name: "Fixed" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Fixed" })).toBeTruthy();
  });
});

describe("Drawer and DrawerToggle", () => {
  function Harness({ mode }: { mode?: "overlay" | "push" }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <kit.DrawerToggle
          open={open}
          onOpenChange={setOpen}
          label="Filters"
          controls="filters"
          badge={2}
        />
        <kit.Drawer
          open={open}
          onOpenChange={setOpen}
          mode={mode}
          panelId="filters"
          title="Filters"
          panel={
            <>
              <button type="button">First</button>
              <button type="button">Last</button>
            </>
          }
        >
          <button type="button">Behind</button>
        </kit.Drawer>
      </>
    );
  }

  it("opens as a modal overlay that holds focus and closes on Escape", () => {
    mount(<Harness />);
    const toggle = screen.getByRole("button", { name: "Filters (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("filters");
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    expect(dialog.id).toBe("filters");
    expect(document.activeElement?.textContent).toBe("First");
    // The pane behind is out of reach while the drawer holds focus.
    expect(document.querySelector("[data-drawer-content]")?.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle);
    // Reopened, Tab wraps inside it: from the last control back to Close.
    fireEvent.click(toggle);
    screen.getByRole("button", { name: "Last" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close Filters" }));
  });

  it("opens to the first control Tab can reach, past hidden ones", () => {
    mount(
      <kit.Drawer
        open
        title="Filters"
        panel={
          <>
            <input type="hidden" name="token" />
            <button type="button" tabIndex={-1}>
              Skipped
            </button>
            <div hidden>
              <button type="button">Hidden</button>
            </div>
            <button type="button">Reachable</button>
          </>
        }
      >
        Content
      </kit.Drawer>
    );
    expect(document.activeElement?.textContent).toBe("Reachable");
  });

  it("closes on the scrim", () => {
    mount(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Filters (2)" }));
    fireEvent.mouseDown(document.querySelector("[data-drawer-scrim]")!, { button: 0 });
    expect(screen.getByRole("button", { name: "Filters (2)" }).getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("pushes beside the content without a scrim or a trap", () => {
    mount(<Harness mode="push" />);
    fireEvent.click(screen.getByRole("button", { name: "Filters (2)" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const panel = screen.getByRole("complementary", { name: "Filters" });
    expect(document.activeElement).toBe(panel);
    expect(document.querySelector("[data-drawer-scrim]")).toBeNull();
    expect(document.querySelector("[data-drawer-content]")?.hasAttribute("inert")).toBe(false);
  });

  it("falls back on bad props rather than throwing", () => {
    mount(
      untyped("Drawer", {
        open: "yes",
        side: "diagonal",
        mode: 4,
        size: -3,
        panel: { not: "a node" },
        children: "Content",
      })
    );
    expect(screen.getByText("Content")).toBeTruthy();
    const panel = document.querySelector<HTMLElement>("[data-drawer-panel]")!;
    expect(panel.getAttribute("data-drawer-panel")).toBe("right");
    expect(panel.getAttribute("data-state")).toBe("closed");
    expect(panel.style.width).toBe("320px");
  });
});

describe("GroupedVirtualList", () => {
  const groups = [
    { id: "open", label: "Open", items: ["a", "b", "c"] },
    { id: "review", label: "In review", items: ["d"] },
    { id: "closed", label: "Closed", items: ["e", "f"], count: 120 },
  ];

  it("draws each group under a header with its count and rows indexed across the list", () => {
    const seen: [string, number, string][] = [];
    mount(
      <div style={{ height: 600 }}>
        <kit.GroupedVirtualList
          aria-label="Issues"
          groups={groups}
          renderItem={(item, index, group) => {
            seen.push([item, index, group.id]);
            return <div>{item}</div>;
          }}
        />
      </div>
    );
    const headers = [...document.querySelectorAll("[data-group-header]")].map(
      (header) => header.textContent
    );
    expect(headers).toEqual(["Open3", "In review1", "Closed120"]);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["a", 0, "open"],
        ["d", 3, "review"],
        ["f", 5, "closed"],
      ])
    );
    expect(screen.getByRole("list", { name: "Issues" })).toBeTruthy();
  });

  it("folds a group from its header and reports the folded ids", () => {
    const onCollapsedGroupsChange = vi.fn();
    mount(
      <kit.GroupedVirtualList
        aria-label="Issues"
        groups={groups}
        collapsible
        onCollapsedGroupsChange={onCollapsedGroupsChange}
        renderItem={(item) => <div>{item}</div>}
      />
    );
    const toggle = screen.getByRole("button", { name: /Open/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(onCollapsedGroupsChange).toHaveBeenLastCalledWith(["open"]);
    expect(screen.queryByText("a")).toBeNull();
    expect(screen.getByText("d")).toBeTruthy();
  });

  it("shows the empty state when every group is empty, and the footer after the rows", () => {
    mount(
      <kit.GroupedVirtualList
        aria-label="Issues"
        groups={[{ id: "open", label: "Open", items: [] }]}
        empty={<p>No issues match</p>}
        renderItem={() => null}
      />
    );
    expect(screen.getByText("No issues match")).toBeTruthy();
    cleanup();
    mount(
      <kit.GroupedVirtualList
        aria-label="Issues"
        groups={groups}
        footer={<p>End of list</p>}
        renderItem={(item) => <div>{item}</div>}
      />
    );
    expect(screen.getByText("End of list")).toBeTruthy();
  });

  it("reports the last row's index, not Virtuoso's count with headers", () => {
    const onEndReached = vi.fn();
    mount(
      <div style={{ height: 600 }}>
        <kit.GroupedVirtualList
          aria-label="Issues"
          groups={groups}
          onEndReached={onEndReached}
          renderItem={(item) => <div>{item}</div>}
        />
      </div>
    );
    expect(onEndReached).toHaveBeenLastCalledWith(5);
  });

  it("keeps a header's Enter from reaching the list's own handler", () => {
    const onKeyDown = vi.fn();
    mount(
      <kit.GroupedVirtualList
        aria-label="Issues"
        groups={groups}
        collapsible
        tabIndex={0}
        role="listbox"
        onKeyDown={onKeyDown}
        renderItem={(item) => (
          <div role="option" aria-selected={false}>
            {item}
          </div>
        )}
      />
    );
    fireEvent.keyDown(screen.getAllByRole("button", { name: /Open/ })[0]!, { key: "Enter" });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("hands the group's own count to renderItem", () => {
    const counts: unknown[] = [];
    mount(
      <kit.GroupedVirtualList
        aria-label="Issues"
        groups={groups}
        renderItem={(item, _index, group) => {
          counts.push(group.count);
          return <div>{item}</div>;
        }}
      />
    );
    expect(counts).toContain(120);
  });

  it("offsets each group by the rows before it", () => {
    expect(groupOffsets([3, 0, 2, 5])).toEqual([0, 3, 3, 5]);
  });
});

describe("BulkActionBar", () => {
  it("renders nothing without a selection", () => {
    const { container } = mount(<kit.BulkActionBar count={0} onClear={() => {}} />);
    expect(container.querySelector("[data-bulk-action-bar]")).toBeNull();
  });

  it("names the selection and clears it from the button or Escape", () => {
    const clear = vi.fn();
    const close = vi.fn();
    mount(
      <kit.BulkActionBar
        selection={{ count: 3, clear }}
        noun="issue"
        hiddenCount={1}
        actions={[{ id: "close", label: "Close", onSelect: close }]}
      />
    );
    const bar = screen.getByRole("group", { name: "Bulk actions" });
    expect(bar.textContent).toContain("3 issues selected · 1 not shown");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("takes an irregular noun and prefers an explicit count and clear", () => {
    const onClear = vi.fn();
    const selectionClear = vi.fn();
    mount(
      <kit.BulkActionBar
        count={1}
        selection={{ count: 9, clear: selectionClear }}
        onClear={onClear}
        noun={{ one: "pull request", other: "pull requests" }}
      />
    );
    expect(screen.getByRole("group").textContent).toContain("1 pull request selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(selectionClear).not.toHaveBeenCalled();
  });
});

describe("LoadMoreFooter", () => {
  it("steps through idle, loading, done and error", () => {
    const load = vi.fn();
    const view = mount(
      <kit.LoadMoreFooter
        status="idle"
        onLoadMore={load}
        loadedCount={50}
        totalCount={212}
        noun="issue"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText("50 of 212")).toBeTruthy();
    view.update(<kit.LoadMoreFooter status="loading" onLoadMore={load} data-testid="footer" />);
    expect(screen.getByTestId("footer").getAttribute("aria-busy")).toBe("true");
    view.update(<kit.LoadMoreFooter status="done" totalCount={212} noun="issue" />);
    expect(screen.getAllByText("All 212 issues loaded").length).toBeGreaterThan(0);
    view.update(<kit.LoadMoreFooter status="error" onLoadMore={load} error="Rate limited" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("disables Retry when there is nothing to retry with", () => {
    mount(<kit.LoadMoreFooter status="error" />);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("keeps focus in the footer when the focused button goes away", () => {
    const view = mount(
      <kit.LoadMoreFooter status="idle" onLoadMore={() => {}} data-testid="footer" />
    );
    screen.getByRole("button", { name: "Load more" }).focus();
    view.update(<kit.LoadMoreFooter status="done" data-testid="footer" />);
    expect(document.activeElement).toBe(screen.getByTestId("footer"));
  });

  it("auto-loads when in view while idle, and again after each page", () => {
    const observers: {
      callback: (entries: { isIntersecting: boolean }[]) => void;
      disconnected: boolean;
    }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly entry: {
          callback: (entries: { isIntersecting: boolean }[]) => void;
          disconnected: boolean;
        };
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          this.entry = { callback, disconnected: false };
          observers.push(this.entry);
        }
        observe() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      }
    );
    const load = vi.fn();
    const intersect = () => {
      const live = observers.filter((observer) => !observer.disconnected).at(-1);
      act(() => live?.callback([{ isIntersecting: true }]));
    };
    const view = mount(<kit.LoadMoreFooter status="idle" onLoadMore={load} autoLoad />);
    intersect();
    intersect();
    expect(load).toHaveBeenCalledTimes(1);
    view.update(<kit.LoadMoreFooter status="loading" onLoadMore={load} autoLoad />);
    view.update(<kit.LoadMoreFooter status="idle" onLoadMore={load} autoLoad />);
    intersect();
    expect(load).toHaveBeenCalledTimes(2);
    view.update(<kit.LoadMoreFooter status="error" onLoadMore={load} autoLoad />);
    intersect();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("TaskList", () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);

  it("summarises by state in the order a reader acts on", () => {
    expect(taskSummary(["done", "running", "failed", "done", "pending"])).toBe(
      "1 running · 1 pending · 1 failed · 2 done"
    );
    expect(taskSummary([])).toBe("");
  });

  it("draws each job with its state, progress, duration and actions", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    mount(
      <kit.TaskList
        aria-label="Sync jobs"
        title="Sync"
        onRetry={onRetry}
        onCancel={onCancel}
        tasks={[
          {
            id: "1",
            title: "Fetch issues",
            status: "running",
            progress: 0.4,
            startedAt: now - 65_000,
          },
          {
            id: "2",
            title: "Fetch labels",
            status: "done",
            startedAt: now - 10_000,
            finishedAt: now - 7_000,
          },
          { id: "3", title: "Push triage", status: "failed", detail: "HTTP 502" },
          // From untyped JS: a state the kit does not know is dropped.
          JSON.parse('{ "id": "4", "title": "Bogus", "status": "exploded" }'),
        ]}
      />
    );
    const list = screen.getByRole("list", { name: "Sync jobs" });
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("1 running · 1 failed · 1 done")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Fetch issues" }).getAttribute("aria-valuenow")
    ).toBe("40");
    expect(screen.getByText("1m")).toBeTruthy();
    expect(screen.getByText("3s")).toBeTruthy();
    expect(screen.getByText("Failed:", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Push triage" }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Fetch issues" }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    // No Retry on work that settled cleanly, no Cancel on work that is over.
    expect(screen.queryByRole("button", { name: "Retry Fetch labels" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel Push triage" })).toBeNull();
  });

  it("offers no actions without handlers, and honours a job that opts out", () => {
    mount(
      <kit.TaskList
        aria-label="Jobs"
        onRetry={() => {}}
        tasks={[
          { id: "1", title: "A", status: "failed", retryable: false },
          { id: "2", title: "B", status: "running" },
        ]}
      />
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("TaskList focus, alignment and announcements", () => {
  it("gives every row the same trailing cells, so durations share a column", () => {
    mount(
      <kit.TaskList
        aria-label="Jobs"
        onRetry={() => {}}
        onCancel={() => {}}
        tasks={[
          { id: "1", title: "A", status: "running" },
          { id: "2", title: "B", status: "done" },
          { id: "3", title: "C", status: "failed" },
        ]}
      />
    );
    const shapes = [...document.querySelectorAll("[data-task-id]")].map(
      (row) => row.children.length
    );
    expect(new Set(shapes).size).toBe(1);
  });

  it("keeps focus on a task's row when its action goes away", () => {
    function Harness() {
      const [status, setStatus] = useState<"running" | "done">("running");
      return (
        <kit.TaskList
          aria-label="Jobs"
          onCancel={() => setStatus("done")}
          tasks={[{ id: "sync", title: "Sync", status }]}
        />
      );
    }
    mount(<Harness />);
    const cancel = screen.getByRole("button", { name: "Cancel Sync" });
    cancel.focus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("button", { name: "Cancel Sync" })).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.taskId).toBe("sync");
  });

  it("announces a task settling, and nothing on the first render or while it runs", () => {
    const first = taskNews(JSON.stringify([["a", "running", "Sync"]]), null);
    expect(first.news).toBe("");
    const still = taskNews(JSON.stringify([["a", "running", "Sync"]]), first.statuses);
    expect(still.news).toBe("");
    const failed = taskNews(JSON.stringify([["a", "failed", "Sync"]]), still.statuses);
    expect(failed.news).toBe("Sync failed");
    expect(taskNews("{}", null).news).toBe("");
  });
});

describe("focus handed back when things go away", () => {
  it("returns focus from a cleared BulkActionBar to where it came from", () => {
    function Harness() {
      const [count, setCount] = useState(2);
      return (
        <>
          <button type="button">Row</button>
          <kit.BulkActionBar count={count} onClear={() => setCount(0)} />
        </>
      );
    }
    mount(<Harness />);
    const row = screen.getByRole("button", { name: "Row" });
    row.focus();
    const clear = screen.getByRole("button", { name: "Clear selection" });
    fireEvent.focus(clear, { relatedTarget: row });
    clear.focus();
    fireEvent.click(clear);
    expect(document.querySelector("[data-bulk-action-bar]")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("hands focus to a pane's handle when the pane folds under it", () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState<string[]>([]);
      return (
        <kit.SplitGroup
          collapsed={collapsed}
          panes={[
            { id: "main", content: "Main" },
            {
              id: "side",
              defaultSize: 200,
              collapsible: true,
              content: (
                <button type="button" onClick={() => setCollapsed(["side"])}>
                  Fold me
                </button>
              ),
            },
          ]}
        />
      );
    }
    mount(<Harness />);
    const button = screen.getByRole("button", { name: "Fold me" });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole("separator"));
  });

  it("says when the source drops and comes back, not when it merely ages", () => {
    const view = mount(<kit.StaleIndicator updatedAt={Date.now()} />);
    expect(screen.getByRole("status").textContent).toBe("");
    view.update(<kit.StaleIndicator updatedAt={Date.now()} disconnected />);
    expect(screen.getByRole("status").textContent).toBe("Disconnected");
    view.update(<kit.StaleIndicator updatedAt={Date.now()} />);
    expect(screen.getByRole("status").textContent).toBe("Reconnected");
  });
});

describe("RefreshOverlay", () => {
  it("marks the content busy at once and shows the note only past the gate", () => {
    vi.useFakeTimers();
    const view = mount(
      <kit.RefreshOverlay refreshing data-testid="overlay">
        <p>Rows</p>
      </kit.RefreshOverlay>
    );
    const overlay = screen.getByTestId("overlay");
    // Busy is the content, not the live region beside it.
    const busy = overlay.querySelector("[aria-busy]");
    expect(busy?.textContent).toBe("Rows");
    expect(busy?.contains(screen.getByRole("status"))).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("status").textContent).toBe("Updating…");
    view.update(
      <kit.RefreshOverlay refreshing={false} data-testid="overlay">
        <p>Rows</p>
      </kit.RefreshOverlay>
    );
    expect(screen.getByTestId("overlay")).toBe(overlay);
    expect(overlay.querySelector("[aria-busy]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByText("Rows")).toBeTruthy();
  });
});

describe("StaleIndicator", () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);

  it("reads fresh, stale by age, stale by flag and disconnected", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const view = mount(
      <kit.StaleIndicator data-testid="s" updatedAt={now - 60_000} staleAfterMs={5 * 60_000} />
    );
    expect(screen.getByTestId("s").getAttribute("data-stale-state")).toBe("fresh");
    expect(screen.getByTestId("s").textContent).toContain("Updated");
    const at = (props: Record<string, unknown>) =>
      view.update(<kit.StaleIndicator data-testid="s" {...props} />);
    at({ updatedAt: now - 10 * 60_000, staleAfterMs: 5 * 60_000 });
    expect(screen.getByTestId("s").getAttribute("data-stale-state")).toBe("stale");
    at({ updatedAt: now, stale: true });
    expect(screen.getByTestId("s").getAttribute("data-stale-state")).toBe("stale");
    at({ updatedAt: now, stale: true, disconnected: true });
    expect(screen.getByTestId("s").getAttribute("data-stale-state")).toBe("disconnected");
    expect(screen.getByTestId("s").textContent).toMatch(/^Disconnected·Updated/);
    at({});
    expect(screen.getByText("Not updated yet")).toBeTruthy();
  });

  it("refreshes from its button, and not while a refresh is in flight", () => {
    const onRefresh = vi.fn();
    const view = mount(<kit.StaleIndicator updatedAt={Date.now()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    view.update(<kit.StaleIndicator updatedAt={Date.now()} onRefresh={onRefresh} refreshing />);
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
