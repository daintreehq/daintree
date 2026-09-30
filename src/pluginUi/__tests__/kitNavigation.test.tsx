// @vitest-environment jsdom
import {
  createElement,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext, type VirtuosoHandle } from "react-virtuoso";

// jsdom lays nothing out, so a Virtuoso never scrolls there; the palette's
// requests to its list are recorded instead, passing through unchanged.
const listScrolls = vi.hoisted((): { method: string; index: number }[] => []);

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  const indexOf = (location: unknown): number => {
    const index =
      typeof location === "object" && location !== null ? Reflect.get(location, "index") : location;
    return typeof index === "number" ? index : -1;
  };
  function RecordingVirtuoso(props: Record<string, unknown> & { ref?: Ref<VirtuosoHandle> }) {
    const { ref, ...rest } = props;
    const inner = useRef<VirtuosoHandle>(null);
    useImperativeHandle(ref, () => ({
      scrollToIndex: (location) => {
        listScrolls.push({ method: "scrollToIndex", index: indexOf(location) });
        inner.current?.scrollToIndex(location);
      },
      scrollIntoView: (location) => {
        listScrolls.push({ method: "scrollIntoView", index: indexOf(location) });
        inner.current?.scrollIntoView(location);
      },
      scrollTo: (location) => inner.current?.scrollTo(location),
      scrollBy: (location) => inner.current?.scrollBy(location),
      getState: (callback) => inner.current?.getState(callback),
      autoscrollToBottom: () => inner.current?.autoscrollToBottom(),
    }));
    return createElement(actual.Virtuoso as ComponentType<Record<string, unknown>>, {
      ...rest,
      ref: inner,
    });
  }
  return { ...actual, Virtuoso: RecordingVirtuoso };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { readNavSections, readSteps } from "@/components/PluginKit/PluginKitNavigation";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function renderLoose<P extends object>(component: ComponentType<P>, looseProps: string) {
  const props: P = JSON.parse(looseProps);
  return render(createElement(component, props));
}

function inViewport(children: ReactNode) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight: 600, itemHeight: 34 } },
    children
  );
}

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("ContextMenu", () => {
  function row(onSelect = vi.fn(), extra: Record<string, unknown> = {}) {
    return createElement(kit.ContextMenu, {
      items: [
        { type: "label", label: "Row" },
        { label: "Rename", onSelect, shortcut: "F2" },
        { type: "separator" },
        { type: "checkbox", label: "Pinned", checked: true, onCheckedChange: () => {} },
      ],
      "aria-label": "Row actions",
      ...extra,
      children: createElement(
        "div",
        { "data-testid": "row" },
        createElement("button", { type: "button" }, "Open")
      ),
    });
  }

  it("opens on a right-click with the DropdownMenu rows", async () => {
    const onSelect = vi.fn();
    render(row(onSelect));
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-label")).toBe("Row actions");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Pinned" }).getAttribute("aria-checked")
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens from Shift+F10 and the Menu key, and stands the global handler down", async () => {
    render(row());
    const surface = screen.getByTestId("row");
    expect(surface.hasAttribute("data-row-menu")).toBe(true);
    const button = screen.getByRole("button", { name: "Open" });
    button.focus();
    fireEvent.keyDown(button, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeTruthy();
    cleanup();

    render(row());
    fireEvent.keyDown(screen.getByRole("button", { name: "Open" }), { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("leaves other keys alone", async () => {
    render(row());
    fireEvent.keyDown(screen.getByRole("button", { name: "Open" }), { key: "F10" });
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders the surface alone while disabled, and nothing for a non-element child", () => {
    render(row(vi.fn(), { disabled: true }));
    expect(screen.getByTestId("row").hasAttribute("data-row-menu")).toBe(false);
    cleanup();
    expect(() =>
      renderLoose(kit.ContextMenu, JSON.stringify({ items: "nope", children: { x: 1 } }))
    ).not.toThrow();
  });
});

describe("Sheet", () => {
  it("slides in against the right edge by default, with the Dialog's parts", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn();
    render(
      createElement(kit.Sheet, {
        open: true,
        onOpenChange,
        title: "Issue #12",
        description: "Opened 3 days ago",
        primaryAction: { label: "Save", onClick: onSave },
        secondaryAction: { label: "Cancel", onClick: () => onOpenChange(false) },
        "data-testid": "sheet",
        children: createElement("p", null, "Body"),
      })
    );
    const root = await screen.findByTestId("sheet");
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.className).toContain("justify-end");
    const surface = root.firstElementChild!;
    expect(surface.className).toContain("h-full");
    expect(surface.className).toContain("border-l");
    expect(surface.className).not.toContain("rounded-[var(--radius-xl)]");
    expect(surface.className).toContain("max-w-xl");
    expect(screen.getByText("Body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens against the left edge at a wider preset", async () => {
    render(
      createElement(kit.Sheet, {
        open: true,
        onOpenChange: () => {},
        title: "Filters",
        side: "left",
        size: "xl",
        "data-testid": "sheet",
      })
    );
    const root = await screen.findByTestId("sheet");
    expect(root.className).toContain("justify-start");
    expect(root.firstElementChild!.className).toContain("border-r");
    expect(root.firstElementChild!.className).toContain("max-w-4xl");
  });

  it("falls back to the defaults for bad values", async () => {
    renderLoose(
      kit.Sheet,
      JSON.stringify({ open: true, title: "x", side: "top", size: "huge", "data-testid": "sheet" })
    );
    const root = await screen.findByTestId("sheet");
    expect(root.className).toContain("justify-end");
    expect(root.firstElementChild!.className).toContain("max-w-xl");
  });
});

describe("CommandPalette", () => {
  const items = [
    { id: "alpha", label: "Alpha issue", description: "In Daintree", group: "Issues" },
    { id: "beta", label: "Beta branch", group: "Branches", shortcut: "Cmd+B" },
    { id: "gamma", label: "Gamma issue", group: "Issues", disabled: true },
    { id: "delta", label: "Delta issue", group: "Issues", keywords: ["urgent"] },
  ];

  function Harness(props: Record<string, unknown>) {
    const [open, setOpen] = useState(true);
    return createElement(kit.CommandPalette, {
      open,
      onOpenChange: setOpen,
      items,
      onSelect: () => {},
      title: "Go to",
      ...props,
    });
  }

  function options(): string[] {
    return screen
      .getAllByRole("option")
      .map(
        (option) =>
          option.getAttribute("aria-label") ?? option.querySelector(".text-sm")?.textContent ?? ""
      );
  }

  it("groups rows under their headings in first-seen order", async () => {
    render(inViewport(createElement(Harness)));
    const listbox = await screen.findByRole("listbox");
    expect(listbox.getAttribute("aria-label")).toBe("Go to");
    expect(options()).toEqual([
      "Issues",
      "Alpha issue",
      "Gamma issue",
      "Delta issue",
      "Branches",
      "Beta branch",
    ]);
    expect(screen.getByRole("dialog", { name: "Go to" })).toBeTruthy();
  });

  it("filters, marks the match and selects with Enter, then closes", async () => {
    const onSelect = vi.fn();
    const onQueryChange = vi.fn();
    render(inViewport(createElement(Harness, { onSelect, onQueryChange })));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "urgent" } });
    expect(onQueryChange).toHaveBeenLastCalledWith("urgent");
    const rows = screen.getAllByRole("option").filter((option) => option.id);
    expect(rows.map((row) => row.textContent)).toEqual(["Delta issue"]);
    fireEvent.change(input, { target: { value: "beta" } });
    expect(document.querySelector(".bg-overlay-medium")?.textContent).toBe("Beta");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    // Closed: the palette plays its exit and drops its modal claim meanwhile.
    expect(screen.getByRole("dialog", { hidden: true }).getAttribute("aria-modal")).toBe("false");
  });

  it("skips disabled rows with the arrow keys", async () => {
    const onSelect = vi.fn();
    render(inViewport(createElement(Harness, { onSelect })));
    const input = await screen.findByRole("combobox");
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active()?.textContent).toContain("Alpha issue");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()?.textContent).toBe("Delta issue");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()?.textContent).toContain("Alpha issue");
    fireEvent.click(screen.getByText("Gamma issue"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows items as given when it does not filter", async () => {
    render(inViewport(createElement(Harness, { filter: false })));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getAllByRole("option").filter((option) => option.id)).toHaveLength(4);
  });

  it("says what is empty, and nothing while it loads", async () => {
    render(inViewport(createElement(Harness, { items: [], emptyText: "No issues yet" })));
    expect(await screen.findByText("No issues yet")).toBeTruthy();
    cleanup();
    render(
      inViewport(createElement(Harness, { items: [], emptyText: "No issues yet", loading: true }))
    );
    await screen.findByRole("combobox");
    expect(screen.queryByText("No issues yet")).toBeNull();
  });

  it("stacks above the nested dialog it opens from", async () => {
    render(
      inViewport(
        createElement(kit.Sheet, {
          open: true,
          onOpenChange: () => {},
          title: "Settings",
          layer: "nested",
          children: createElement(Harness),
        })
      )
    );
    const palette = await screen.findByRole("dialog", { name: "Go to" });
    expect(palette.parentElement?.className).toContain("z-[calc(var(--z-nested-dialog)+1)]");
    cleanup();
    render(inViewport(createElement(Harness)));
    const plain = await screen.findByRole("dialog", { name: "Go to" });
    expect(plain.parentElement?.className).toContain("z-[var(--z-modal)]");
  });

  it("brings the active row into view after a search", async () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `file-${index}`,
      label: `report-${String(index).padStart(3, "0")}.md`,
      group: index < 200 ? "Recent" : "Older",
    }));
    render(inViewport(createElement(Harness, { items: many })));
    const input = await screen.findByRole("combobox");
    listScrolls.length = 0;
    fireEvent.keyDown(input, { key: "End" });
    expect(listScrolls).toEqual([{ method: "scrollIntoView", index: 401 }]);
    listScrolls.length = 0;
    // Every row still matches, so the list would keep its scroll at the end
    // while the cursor went back to the first row.
    fireEvent.change(input, { target: { value: "report" } });
    await tick();
    await tick();
    expect(listScrolls.at(-1)).toEqual({ method: "scrollToIndex", index: 0 });
  });

  it("tells the plugin the search is empty when closed from outside, once", async () => {
    const onQueryChange = vi.fn();
    function Outside() {
      const [open, setOpen] = useState(true);
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => setOpen(false) }, "Hide"),
        createElement(kit.CommandPalette, {
          open,
          onOpenChange: setOpen,
          items,
          onSelect: () => {},
          title: "Go to",
          filter: false,
          onQueryChange,
        })
      );
    }
    render(inViewport(createElement(Outside)));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "foo" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide", hidden: true }));
    await tick();
    expect(onQueryChange.mock.calls).toEqual([["foo"], [""]]);
    cleanup();

    onQueryChange.mockClear();
    render(inViewport(createElement(Harness, { onQueryChange })));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(onQueryChange.mock.calls).toEqual([["beta"], [""]]);
  });

  it("drops malformed and duplicate items without throwing", async () => {
    render(
      inViewport(
        createElement(Harness, {
          items: [
            { id: "a", label: "A" },
            { id: "a", label: "Again" },
            { label: "No id" },
            "x",
            null,
          ],
          onSelect: "nope",
          onOpenChange: 3,
        })
      )
    );
    await screen.findByRole("combobox");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["A"]);
  });
});

describe("Breadcrumbs", () => {
  it("links each level back and marks the last as the current page", () => {
    const onProjects = vi.fn();
    render(
      createElement(kit.Breadcrumbs, {
        items: [
          { label: "Projects", onSelect: onProjects, icon: "folder" },
          { label: "Daintree" },
          { label: "Settings" },
        ],
        "data-testid": "trail",
      })
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.getAttribute("data-testid")).toBe("trail");
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(onProjects).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Daintree" })).toBeNull();
    const current = screen.getByText("Settings").closest("[aria-current]");
    expect(current?.getAttribute("aria-current")).toBe("page");
  });

  it("folds the middle crumbs into a menu past maxItems", async () => {
    const onB = vi.fn();
    render(
      createElement(kit.Breadcrumbs, {
        maxItems: 3,
        items: [
          { label: "A", onSelect: () => {} },
          { label: "B", onSelect: onB },
          { label: "C", onSelect: () => {} },
          { label: "D", onSelect: () => {} },
          { label: "E" },
        ],
      })
    );
    const crumbs = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(crumbs).toEqual(["A", "D", "E"]);
    const more = screen.getByRole("button", { name: "Show 2 more" });
    fireEvent.keyDown(more, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "B" }));
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("ignores bad items and a bad maxItems", () => {
    renderLoose(
      kit.Breadcrumbs,
      JSON.stringify({ items: [{ label: "Only" }, { nope: true }, 3], maxItems: "two" })
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Only"]);
  });
});

describe("NavList", () => {
  const sections: kit.NavListSection[] = [
    {
      label: "Views",
      items: [
        { id: "inbox", label: "Inbox", icon: "inbox", count: 1200 },
        { id: "archived", label: "Archived", disabled: true },
        { id: "labels", label: "Labels", children: [{ id: "bugs", label: "Bugs" }] },
      ],
    },
    { items: [{ id: "settings", label: "Settings", badge: "New" }] },
  ];

  it("marks the selected destination and moves by keyboard, skipping disabled rows", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NavList, {
        sections,
        value: "inbox",
        onValueChange,
        "aria-label": "Sections",
      })
    );
    const list = screen.getByRole("listbox", { name: "Sections" });
    const rows = screen.getAllByRole("option").filter((option) => option.id.includes("option"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Inbox1.2k",
      "Archived",
      "Labels",
      "Bugs",
      "SettingsNew",
    ]);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[2]!.getAttribute("aria-selected")).toBe("false");
    expect(rows[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(rows[3]!.className).toContain("pl-9");
    expect(rows[0]!.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(rows[2]!.id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("labels");
    fireEvent.click(rows[1]!);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("keeps its own selection when uncontrolled", () => {
    render(
      createElement(kit.NavList, {
        items: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        defaultValue: "a",
        "aria-label": "Sections",
      })
    );
    const b = screen.getAllByRole("option")[1]!;
    fireEvent.click(b);
    expect(b.getAttribute("aria-selected")).toBe("true");
  });

  it("reads one level of children and drops malformed rows", () => {
    const bands = readNavSections(
      [
        {
          label: "",
          items: [
            {
              id: "a",
              label: "A",
              count: 0,
              children: [{ id: "b", label: "B", children: [{ id: "c", label: "C" }] }],
            },
            { id: "a", label: "Dupe" },
            { label: "No id" },
          ],
        },
        "x",
      ],
      undefined
    );
    expect(bands).toHaveLength(1);
    expect(bands[0]!.label).toBeUndefined();
    expect(bands[0]!.entries.map((entry) => [entry.id, entry.depth, entry.count])).toEqual([
      ["a", 0, undefined],
      ["b", 1, undefined],
    ]);
    expect(() =>
      renderLoose(kit.NavList, JSON.stringify({ sections: "x", "aria-label": 3 }))
    ).not.toThrow();
  });
});

describe("Stepper", () => {
  const steps = [
    { id: "details", label: "Details" },
    { id: "repo", label: "Repository", description: "Pick one" },
    { id: "review", label: "Review" },
  ];

  it("derives each step's state from the current one", () => {
    expect(readSteps(steps, "repo").map((step) => step.state)).toEqual([
      "complete",
      "current",
      "upcoming",
    ]);
    expect(
      readSteps([...steps.slice(0, 2), { ...steps[2]!, state: "error" }], "details").map(
        (step) => step.state
      )
    ).toEqual(["current", "upcoming", "error"]);
    expect(readSteps(steps, "nowhere").every((step) => step.state === "upcoming")).toBe(true);
  });

  it("marks the current step and lets completed ones be revisited", () => {
    const onStepSelect = vi.fn();
    render(createElement(kit.Stepper, { steps, current: "repo", onStepSelect }));
    const list = screen.getByRole("list", { name: "Progress" });
    const items = list.querySelectorAll("li");
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(items[0]!.getAttribute("aria-current")).toBeNull();
    const back = screen.getByRole("button", { name: "Details, completed" });
    fireEvent.click(back);
    expect(onStepSelect).toHaveBeenCalledWith("details");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("draws the error glyph and a vertical rail", () => {
    const { container } = render(
      createElement(kit.Stepper, {
        steps: [{ id: "a", label: "A", state: "error" }, ...steps],
        current: "details",
        orientation: "vertical",
      })
    );
    expect(container.querySelector("svg.text-status-danger")).not.toBeNull();
    expect(screen.getByText(", needs attention")).toBeTruthy();
    expect(container.querySelector("ol")?.className).toContain("flex-col");
  });

  it("renders nothing for bad steps without throwing", () => {
    const { container } = renderLoose(
      kit.Stepper,
      JSON.stringify({ steps: "x", current: 4, orientation: "diagonal" })
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
