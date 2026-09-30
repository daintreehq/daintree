// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { isShrinkKey } from "@/components/PluginKit/PluginKitLayout";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function element(found: Element | null | undefined): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error("no element");
  return found;
}

describe("Card", () => {
  it("draws a header, body and footer on the host card frame", () => {
    const { container } = render(
      createElement(
        kit.Card,
        {
          title: "Deployment",
          description: "Production, eu-west",
          actions: createElement("button", { type: "button" }, "Redeploy"),
          footer: "Updated 5m ago",
          "data-testid": "card",
        },
        "Body"
      )
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-slot")).toBe("card");
    expect(card.getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("heading", { name: "Deployment" }).tagName).toBe("H3");
    expect(screen.getByRole("button", { name: "Redeploy" })).toBeTruthy();
    expect(card.textContent).toContain("Body");
    expect(card.textContent).toContain("Updated 5m ago");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(card.className).not.toMatch(/accent/);
  });

  it("maps inset to the receding host surface", () => {
    render(createElement(kit.Card, { variant: "inset", "data-testid": "card" }, "x"));
    expect(screen.getByTestId("card").getAttribute("data-variant")).toBe("subtle");
  });

  it("becomes one labelled button with onClick, and drops its actions", () => {
    const onClick = vi.fn();
    render(
      untyped("Card", {
        title: "Open project",
        description: "Pick a folder",
        onClick,
        actions: createElement("button", { type: "button" }, "Nested"),
      })
    );
    const button = screen.getByRole("button", { name: "Open project" });
    expect(button.getAttribute("data-slot")).toBe("choice-card");
    const describedBy = button.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Pick a folder");
    expect(button.querySelector("div, h3, p, button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Nested" })).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a clickable card's own ARIA references, adding its description to them", () => {
    render(
      createElement(
        "div",
        null,
        createElement("h2", { id: "outer-heading" }, "Recent project"),
        createElement("p", { id: "outer-hint" }, "Opens in a new window"),
        untyped("Card", {
          description: "Pick a folder",
          onClick: () => {},
          "aria-labelledby": "outer-heading",
          "aria-describedby": "outer-hint",
        })
      )
    );
    const button = screen.getByRole("button", { name: "Recent project" });
    const refs = (button.getAttribute("aria-describedby") ?? "").split(" ");
    expect(refs.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Pick a folder",
      "Opens in a new window",
    ]);
    cleanup();

    render(untyped("Card", { title: "Open project", onClick: () => {}, "aria-label": "Open it" }));
    const named = screen.getByRole("button", { name: "Open it" });
    expect(named.hasAttribute("aria-labelledby")).toBe(false);
    expect(named.hasAttribute("aria-describedby")).toBe(false);
  });

  it("disables a clickable card", () => {
    const onClick = vi.fn();
    render(createElement(kit.Card, { title: "Retry", onClick, disabled: true }));
    const button = screen.getByRole("button", { name: "Retry" });
    if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
    expect(button.disabled).toBe(true);
  });

  it("degrades bad props to a static default card", () => {
    render(
      untyped("Card", {
        onClick: "nope",
        variant: "loud",
        padding: 7,
        title: { not: "a node" },
        "data-testid": "card",
      })
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-variant")).toBe("default");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Divider and SectionLabel", () => {
  it("draws a separator on either axis", () => {
    render(
      createElement("div", null, [
        createElement(kit.Divider, { key: "h", "data-testid": "h" }),
        createElement(kit.Divider, { key: "v", orientation: "vertical", "data-testid": "v" }),
      ])
    );
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(screen.getByTestId("h").tagName).toBe("HR");
    expect(screen.getByTestId("v").getAttribute("aria-orientation")).toBe("vertical");
  });

  it("keeps a labelled divider's text readable rather than presentational", () => {
    render(createElement(kit.Divider, { label: "Older", "data-testid": "d" }));
    const divider = screen.getByTestId("d");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(divider.textContent).toBe("Older");
    expect(divider.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it("renders a section heading by default and a list label on request", () => {
    render(
      createElement("div", null, [
        createElement(kit.SectionLabel, { key: "s" }, "Commands"),
        createElement(
          kit.SectionLabel,
          { key: "l", variant: "list", "data-testid": "l" },
          "Recent"
        ),
        untyped("SectionLabel", { key: "b", as: "script" }, "Bad"),
      ])
    );
    expect(screen.getByRole("heading", { name: "Commands" }).tagName).toBe("H3");
    expect(screen.getByTestId("l").tagName).toBe("DIV");
    expect(screen.getByRole("heading", { name: "Bad" }).tagName).toBe("H3");
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("ResizableSplit", () => {
  function separator(): HTMLElement {
    return screen.getByRole("separator");
  }
  function sizedPane(container: HTMLElement): HTMLElement {
    return element(container.querySelector('[data-split-pane="sized"]'));
  }

  it("sizes the first pane and names the divider", () => {
    const { container } = render(
      createElement(kit.ResizableSplit, {
        first: "List",
        second: "Detail",
        "aria-label": "Resize list",
        defaultSize: 300,
      })
    );
    const handle = separator();
    expect(handle.getAttribute("aria-label")).toContain("Resize list");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(handle.getAttribute("aria-controls")).toBe(sizedPane(container).id);
    expect(sizedPane(container).style.width).toBe("300px");
    expect(sizedPane(container).textContent).toBe("List");
  });

  it("steps from the keyboard within min and max and reports each commit", () => {
    const onSizeChange = vi.fn();
    render(
      createElement(kit.ResizableSplit, {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        defaultSize: 200,
        minSize: 180,
        maxSize: 400,
        onSizeChange,
      })
    );
    const handle = separator();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("210");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("180");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    expect(onSizeChange.mock.calls.map(([size]) => size)).toEqual([210, 180, 400]);
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
  });

  it("grows the second pane with the arrow that points into it", () => {
    const { container } = render(
      createElement(kit.ResizableSplit, {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        orientation: "vertical",
        sizedPane: "second",
        defaultSize: 200,
      })
    );
    const handle = separator();
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(sizedPane(container).style.height).toBe("210px");
    expect(sizedPane(container).textContent).toBe("b");
    // DOM order stays first, divider, second.
    const children = [...element(container.firstElementChild).children];
    expect(children.map((child) => child.textContent)).toEqual(["a", "", "b"]);
  });

  it("drags by pointer travel and commits once on release", () => {
    const onSizeChange = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { container } = render(
      createElement(kit.ResizableSplit, {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        defaultSize: 240,
        onSizeChange,
      })
    );
    const handle = separator();
    fireEvent.mouseDown(handle, { button: 0, clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 130, buttons: 1 });
    fireEvent.mouseMove(document, { clientX: 160, buttons: 1 });
    expect(handle.getAttribute("data-resizing")).toBe("true");
    expect(sizedPane(container).style.width).toBe("300px");
    expect(onSizeChange).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    expect(onSizeChange.mock.calls).toEqual([[300]]);
    expect(handle.getAttribute("data-resizing")).toBeNull();
    vi.restoreAllMocks();
  });

  it("drags from the drawn size when the container caps the pane", () => {
    const onSizeChange = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { container } = render(
      createElement(kit.ResizableSplit, {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        defaultSize: 640,
        onSizeChange,
      })
    );
    vi.spyOn(sizedPane(container), "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 394, height: 200 })
    );
    const handle = separator();
    fireEvent.mouseDown(handle, { button: 0, clientX: 400, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 380, buttons: 1 });
    expect(sizedPane(container).style.width).toBe("374px");
    fireEvent.mouseUp(document);
    expect(onSizeChange.mock.calls).toEqual([[374]]);
    vi.restoreAllMocks();
  });

  it("follows a controlled size and snaps back when the parent keeps it", () => {
    render(
      createElement(kit.ResizableSplit, {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        size: 250,
        onSizeChange: () => {},
      })
    );
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(separator().getAttribute("aria-valuenow")).toBe("250");
  });

  it("collapses from the keyboard and by dragging, keeping the pane mounted", () => {
    const onCollapsedChange = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return createElement(kit.ResizableSplit, {
        first: createElement("input", { "aria-label": "Filter" }),
        second: "b",
        "aria-label": "Resize",
        defaultSize: 200,
        minSize: 160,
        collapsible: true,
        collapsed,
        onCollapsedChange: (next: boolean) => {
          onCollapsedChange(next);
          setCollapsed(next);
        },
      });
    }
    const { container } = render(createElement(Harness));
    const handle = separator();
    expect(handle.getAttribute("aria-valuemin")).toBe("0");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(handle.getAttribute("aria-valuenow")).toBe("0");
    expect(handle.getAttribute("aria-valuetext")).toBe("Collapsed");
    expect(sizedPane(container).className).toContain("hidden");
    expect(screen.getByLabelText("Filter")).toBeTruthy();
    // Shrinking a collapsed pane does nothing; growing brings it back at its minimum.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("160");
    fireEvent.mouseDown(handle, { button: 0, clientX: 300, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 190, buttons: 1 });
    fireEvent.mouseUp(document);
    expect(onCollapsedChange.mock.calls).toEqual([[true], [false], [true]]);
    vi.restoreAllMocks();
  });

  it("knows which keys shrink the pane on each axis", () => {
    expect(isShrinkKey("ArrowLeft", "ArrowRight")).toBe(true);
    expect(isShrinkKey("ArrowRight", "ArrowLeft")).toBe(true);
    expect(isShrinkKey("PageUp", "ArrowDown")).toBe(true);
    expect(isShrinkKey("PageDown", "ArrowUp")).toBe(true);
    expect(isShrinkKey("End", "ArrowRight")).toBe(false);
  });

  it("degrades bad sizes to the defaults", () => {
    render(
      untyped("ResizableSplit", {
        first: "a",
        second: "b",
        "aria-label": "Resize",
        defaultSize: "wide",
        minSize: -5,
        maxSize: Number.NaN,
        orientation: "diagonal",
      })
    );
    const handle = separator();
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    expect(handle.getAttribute("aria-valuemin")).toBe("160");
    expect(handle.getAttribute("aria-valuemax")).toBe("640");
  });
});

describe("Accordion and Disclosure", () => {
  const items = [
    { value: "a", title: "General", content: "General body" },
    { value: "b", title: "Advanced", content: "Advanced body", trailing: "3" },
    { value: "c", title: "Locked", content: "Locked body", disabled: true },
    { value: "d", title: "Danger zone", content: "Danger body" },
  ];

  it("wires each header to its region and keeps one open in single mode", () => {
    render(createElement(kit.Accordion, { items, defaultValue: ["a"] }));
    const general = screen.getByRole("button", { name: "General" });
    expect(general.getAttribute("aria-expanded")).toBe("true");
    const region = screen.getByRole("region", { name: "General" });
    expect(general.getAttribute("aria-controls")).toBe(region.id);
    expect(region.textContent).toBe("General body");
    expect(general.parentElement?.tagName).toBe("H3");

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(general.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("General body")).toBeNull();
    expect(screen.getByText("Advanced body")).toBeTruthy();
    // Closing the open one leaves none open.
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("puts Accordion and Disclosure chevrons and bodies on the same edge", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.Accordion, { items, defaultValue: ["a"] }),
        createElement(kit.Disclosure, { title: "Details", defaultOpen: true }, "Detail body")
      )
    );
    // jsdom lays nothing out, so the horizontal box classes stand in for position.
    const horizontal = (element: Element | null) =>
      (element?.className ?? "")
        .split(/\s+/)
        .filter((name) => /^-?(m|p|w)[xlr]?-|^w-/.test(name))
        .sort();
    const accordion = screen.getByRole("button", { name: "General" });
    const disclosure = screen.getByRole("button", { name: "Details" });
    expect(horizontal(accordion)).toEqual(horizontal(disclosure));
    expect(horizontal(accordion)).toContain("-mx-1.5");
    expect(horizontal(screen.getByRole("region", { name: "General" }))).toEqual(
      horizontal(screen.getByRole("region", { name: "Details" }))
    );
  });

  it("shows at most one open section in single mode, whatever it is handed", () => {
    const onValueChange = vi.fn();
    render(createElement(kit.Accordion, { items, defaultValue: ["zz", "b", "a"], onValueChange }));
    expect(screen.getAllByRole("region").map((region) => region.textContent)).toEqual([
      "Advanced body",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onValueChange).toHaveBeenLastCalledWith(["a"]);
    cleanup();

    function Switching() {
      const [type, setType] = useState<"single" | "multiple">("multiple");
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => setType("single") }, "One"),
        createElement(kit.Accordion, { items, type, defaultValue: ["a", "d"] })
      );
    }
    render(createElement(Switching));
    expect(screen.getAllByRole("region")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    expect(screen.getAllByRole("region").map((region) => region.textContent)).toEqual([
      "General body",
    ]);
  });

  it("opens many in multiple mode and reports the open set", () => {
    const onValueChange = vi.fn();
    render(createElement(kit.Accordion, { items, type: "multiple", onValueChange }));
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(onValueChange.mock.calls.at(-1)?.[0]).toEqual(["a", "b"]);
  });

  it("follows a controlled value", () => {
    render(createElement(kit.Accordion, { items, value: ["d"], onValueChange: () => {} }));
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("region").textContent).toBe("Danger body");
  });

  it("moves between enabled headers with Up, Down, Home and End", () => {
    render(createElement(kit.Accordion, { items, headingLevel: 4 }));
    const general = screen.getByRole("button", { name: "General" });
    expect(general.parentElement?.tagName).toBe("H4");
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Advanced");
    fireEvent.keyDown(element(document.activeElement), { key: "ArrowDown" });
    // The disabled header is skipped.
    expect(document.activeElement?.textContent).toBe("Danger zone");
    fireEvent.keyDown(element(document.activeElement), { key: "ArrowDown" });
    expect(document.activeElement).toBe(general);
    fireEvent.keyDown(general, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Danger zone");
    fireEvent.keyDown(element(document.activeElement), { key: "Home" });
    expect(document.activeElement).toBe(general);
  });

  it("drops malformed and duplicate items", () => {
    render(
      untyped("Accordion", {
        items: [
          null,
          { title: "No value" },
          { value: "x", title: "X" },
          { value: "x", title: "Dup" },
        ],
        type: "sometimes",
        value: "x",
        headingLevel: 9,
      })
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["X"]);
    expect(screen.getByRole("button").parentElement?.tagName).toBe("H3");
  });

  it("toggles a single disclosure, controlled or not", () => {
    const onOpenChange = vi.fn();
    render(createElement(kit.Disclosure, { title: "Details", onOpenChange }, "Hidden detail"));
    const trigger = screen.getByRole("button", { name: "Details" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hidden detail")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Details" }).textContent).toBe("Hidden detail");
    expect(onOpenChange).toHaveBeenCalledWith(true);
    cleanup();
    render(createElement(kit.Disclosure, { title: "Pinned", open: true }, "Stays"));
    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect(screen.getByText("Stays")).toBeTruthy();
  });
});

describe("DescriptionList", () => {
  function withTooltips(children: ReturnType<typeof createElement>) {
    return createElement(TooltipProvider, null, children);
  }

  it("pairs each label with its value, with a hint and a dash for none", () => {
    const { container } = render(
      createElement(kit.DescriptionList, {
        items: [
          { label: "Branch", value: "main", hint: "Tracking origin/main" },
          { label: "Owner", value: "" },
        ],
      })
    );
    const terms = [...container.querySelectorAll("dt")].map((term) => term.textContent);
    const details = [...container.querySelectorAll("dd")].map((detail) => detail.textContent);
    expect(terms).toEqual(["Branch", "Owner"]);
    expect(details[0]).toBe("mainTracking origin/main");
    expect(details[1]).toContain("None");
  });

  it("stacks labels over values on request", () => {
    const { container } = render(
      createElement(kit.DescriptionList, {
        layout: "stacked",
        items: [{ label: "Branch", value: "main" }],
      })
    );
    const row = element(container.querySelector("dl > div"));
    expect(row.className).toContain("flex-col");
    expect(row.className).not.toContain("grid-cols-subgrid");
  });

  it("copies text values when copyable, and an item's copyText wins", () => {
    render(
      withTooltips(
        createElement(kit.DescriptionList, {
          copyable: true,
          items: [
            { label: "Commit", value: "abc123" },
            { label: "Size", value: 42 },
            {
              label: "Link",
              value: createElement("a", { href: "#" }, "PR"),
              copyText: "https://x",
            },
            { label: "Status", value: createElement("span", null, "Open") },
          ],
        })
      )
    );
    const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Copy Commit", "Copy Size", "Copy Link"]);
  });

  it("takes its rows as children and forwards root attributes", () => {
    const { container } = render(
      createElement(
        kit.DescriptionList,
        { layout: "stacked", "data-testid": "list" },
        createElement(kit.DescriptionListItem, {
          label: "Path",
          value: "/tmp",
          "data-testid": "row",
        })
      )
    );
    expect(screen.getByTestId("list").tagName).toBe("DL");
    expect(screen.getByTestId("row").className).toContain("flex-col");
    expect(container.querySelector("dt")?.textContent).toBe("Path");
  });

  it("ignores malformed items", () => {
    const { container } = render(
      untyped("DescriptionList", {
        items: [null, 4, { label: "Ok", value: { bad: true } }],
        layout: "grid",
      })
    );
    expect(container.querySelectorAll("dt")).toHaveLength(1);
    expect(container.querySelector("dd")?.textContent).toContain("None");
  });
});
