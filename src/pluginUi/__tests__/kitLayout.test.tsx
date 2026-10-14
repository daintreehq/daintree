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
}, 60_000);

afterEach(cleanup);

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function element(found: Element | null | undefined): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error("no element");
  return found;
}

function markup(tree: ReturnType<typeof createElement>): string {
  const { container } = render(tree);
  // useId values differ between renders; the structure is what is compared.
  const html = container.innerHTML.replace(/_r_[0-9a-z]+_/g, "id");
  cleanup();
  return html;
}

function classes(target: Element): string[] {
  return target.className.split(/\s+/).filter(Boolean);
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

  it("keeps the copy buttons in one column that follows the values, not the far edge", () => {
    const { container } = render(
      withTooltips(
        createElement(kit.DescriptionList, {
          copyable: true,
          items: [
            { label: "Email", value: "sofia@example.com" },
            { label: "Region", value: "North America" },
          ],
        })
      )
    );
    const list = element(container.querySelector("dl"));
    // Tracks: label, value, copy, filler. The value track is sized to its
    // content (never stretched to the edge), the copy track comes straight
    // after it, and only the trailing filler takes the leftover width.
    const template = /grid-cols-\[([^\]]+)\]/.exec(list.className)?.[1]?.split("_") ?? [];
    expect(template).toHaveLength(4);
    expect(template[1]).toMatch(/^minmax\(0,max-content\)$|^fit-content/);
    expect(template[1]).not.toContain("fr");
    expect(template[2]).toBe("auto");
    expect(template[3]).toContain("fr");
    // No column gap sits between a value and its button.
    expect(list.className).not.toMatch(/(^|\s)gap-x-|(^|\s)gap-\d/);
    for (const row of container.querySelectorAll("dl > div")) {
      expect(row.className).toContain("col-span-3");
      expect(row.className).toContain("grid-cols-subgrid");
      const detail = element(row.querySelector("dd"));
      // The value and its button share the list's value and copy tracks.
      expect(detail.className).toContain("col-span-2");
      expect(detail.className).toContain("grid-cols-subgrid");
      expect(detail.lastElementChild?.getAttribute("aria-label")).toMatch(/^Copy /);
    }
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

describe("Card variants", () => {
  function cardWith(props: Record<string, unknown>, body: ReactNode = "Body") {
    render(untyped("Card", { title: "Balance", "data-testid": "card", ...props }, body));
    const card = screen.getByTestId("card");
    const heading = screen.getByRole("heading", { name: "Balance" });
    return { card, heading, header: element(heading.parentElement?.parentElement) };
  }

  it("lifts an elevated card onto the host's raised surface", () => {
    const { card } = cardWith({ variant: "elevated" });
    expect(card.getAttribute("data-variant")).toBe("elevated");
    expect(card.className).not.toMatch(/accent/);
  });

  it("draws a feature card raised, rounder, roomier and with a larger title", () => {
    const plain = cardWith({});
    const plainHeading = classes(plain.heading);
    const plainHeader = classes(plain.header);
    const plainRoot = classes(plain.card);
    cleanup();
    const feature = cardWith({ variant: "feature" });
    expect(feature.card.getAttribute("data-variant")).toBe("elevated");
    expect(classes(feature.heading)).not.toEqual(plainHeading);
    expect(classes(feature.header)).not.toEqual(plainHeader);
    expect(classes(feature.card).filter((name) => name.startsWith("rounded-"))).not.toEqual(
      plainRoot.filter((name) => name.startsWith("rounded-"))
    );
  });

  it("caps a feature card in a category colour, and only a feature card", () => {
    expect(cardWith({ variant: "feature", capColor: "teal" }).card.className).toContain(
      "category-teal"
    );
    cleanup();
    // `neutral` is the charts' slate, as it is everywhere a chart colour is drawn.
    expect(cardWith({ variant: "feature", capColor: "neutral" }).card.className).toContain(
      "category-slate"
    );
    cleanup();
    expect(cardWith({ variant: "elevated", capColor: "teal" }).card.className).not.toContain(
      "category-"
    );
    cleanup();
    expect(cardWith({ variant: "feature", capColor: "pink" }).card.className).not.toContain(
      "category-"
    );
    cleanup();
    expect(cardWith({ variant: "feature" }).card.className).not.toContain("category-");
  });

  it("lifts a clickable card through the choice card's elevated tone, cap included", () => {
    const button = (props: Record<string, unknown>) => {
      render(untyped("Card", { title: "Open", onClick: () => {}, ...props }, "Body"));
      const card = screen.getByRole("button", { name: "Open" });
      const read = { tone: card.getAttribute("data-tone"), className: card.className };
      cleanup();
      return read;
    };
    expect(button({}).tone).toBe("default");
    expect(button({ variant: "inset" }).tone).toBe("default");
    expect(button({ variant: "elevated" }).tone).toBe("elevated");
    const feature = button({ variant: "feature", capColor: "blue" });
    expect(feature.tone).toBe("elevated");
    expect(feature.className).toContain("category-blue");
    expect(feature.className).toContain("rounded-[var(--radius-xl)]");
  });

  it("ignores an unknown variant", () => {
    const { card } = cardWith({ variant: "tinted" });
    expect(card.getAttribute("data-variant")).toBe("default");
  });
});

describe("Card spacing", () => {
  function parts(props: Record<string, unknown>) {
    render(untyped("Card", { title: "Rates", "data-testid": "card", ...props }, "Body"));
    const card = screen.getByTestId("card");
    const header = element(
      screen.getByRole("heading", { name: "Rates" }).parentElement?.parentElement
    );
    return { card, header, body: element(header.nextElementSibling) };
  }

  it("sets a padded body apart from the header", () => {
    for (const padding of ["md", "sm"] as const) {
      const { header } = parts({ padding });
      expect(classes(header).some((name) => /^pb-/.test(name))).toBe(true);
      cleanup();
    }
  });

  it("keeps a padding-none body edge to edge under a fully padded header", () => {
    const { header, body } = parts({ padding: "none" });
    expect(classes(header).some((name) => /^pb-/.test(name))).toBe(true);
    expect(classes(body).some((name) => /^(p|px|py|pt|pb)-/.test(name))).toBe(false);
  });

  it("gives a small button's extra height back so it centres on the title line", () => {
    const actions = createElement(kit.Button, { size: "sm" }, "Edit");
    const boxFor = (variant: string) => {
      render(untyped("Card", { title: "Holdings", variant, actions }));
      let box = element(screen.getByRole("button", { name: "Edit" }));
      while (!classes(box).includes("shrink-0") || !box.className.includes("gap-2")) {
        box = element(box.parentElement);
      }
      const names = classes(box);
      cleanup();
      return names;
    };
    const standard = boxFor("default");
    expect(standard).toContain("items-center");
    expect(standard.some((name) => /^-my-/.test(name))).toBe(true);
    // A feature title's line is taller, so less is given back.
    const feature = boxFor("feature");
    expect(feature.some((name) => /^-my-/.test(name))).toBe(true);
    expect(feature.find((name) => /^-my-/.test(name))).not.toBe(
      standard.find((name) => /^-my-/.test(name))
    );
  });
});

describe("Card footerAlign", () => {
  function footerOf(footerAlign: unknown): HTMLElement {
    render(
      untyped(
        "Card",
        {
          footerAlign,
          "data-testid": "card",
          footer: [
            createElement("button", { type: "button", key: "a" }, "Reset"),
            createElement("button", { type: "button", key: "b" }, "Save"),
          ],
        },
        "Body"
      )
    );
    return element(screen.getByTestId("card").lastElementChild);
  }

  it("ends the footer by default and on an unknown value", () => {
    const fallback = footerOf(undefined).className;
    cleanup();
    expect(fallback).toContain("justify-end");
    expect(footerOf("end").className).toBe(fallback);
    cleanup();
    expect(footerOf("spread").className).toBe(fallback);
  });

  it("starts, splits or stretches the footer on request", () => {
    expect(footerOf("start").className).toContain("justify-start");
    cleanup();
    const between = footerOf("between").className;
    expect(between).toContain("justify-end");
    expect(between).toMatch(/first-child\]:mr-auto/);
    cleanup();
    expect(footerOf("stretch").className).toMatch(/\[&>\*\]:flex-1/);
  });
});

describe("Figure", () => {
  it("sets the label above, the figure with its unit, the twin and the caption", () => {
    const { container } = render(
      createElement(kit.Figure, {
        label: "Monthly budget",
        value: "€12,400",
        unit: "/mo",
        twin: "≈ $13,500/mo",
        caption: "After tax",
        "data-testid": "figure",
      })
    );
    const figure = screen.getByTestId("figure");
    expect(figure.textContent).toBe("Monthly budget€12,400/mo≈ $13,500/moAfter tax");
    expect(figure.getAttribute("data-size")).toBe("lg");
    const unit = element(screen.getByText("/mo"));
    const value = element(unit.parentElement);
    expect(value.className).toContain("tabular-nums");
    expect(value.className).toContain("lining-nums");
    expect(unit.className).toContain("font-normal");
    expect(unit.className).toContain("text-text-secondary");
    // The figure wraps; nothing in it is ever cut off.
    expect(container.innerHTML).not.toMatch(/truncate|line-clamp|uppercase|accent/);
  });

  it("draws each size at its own scale, and display steps with its width", () => {
    const valueClasses = new Set<string>();
    for (const size of ["display", "xl", "lg", "md"] as const) {
      render(createElement(kit.Figure, { value: "42", size, "data-testid": "figure" }));
      const figure = screen.getByTestId("figure");
      expect(figure.getAttribute("data-size")).toBe(size);
      valueClasses.add(element(screen.getByText("42")).className);
      if (size === "display") {
        expect(figure.className).toMatch(/@container/);
        expect(screen.getByText("42").className).toMatch(/@[a-z0-9]+\/figure:text-/);
      } else {
        expect(figure.className).not.toMatch(/@container/);
      }
      cleanup();
    }
    expect(valueClasses.size).toBe(4);
  });

  it("sets mono, a signed delta and end alignment", () => {
    const formatDelta = vi.fn((magnitude: number) => `€${magnitude}`);
    render(
      createElement(kit.Figure, {
        value: "€12,400",
        mono: true,
        delta: 300,
        formatDelta,
        align: "end",
        "data-testid": "figure",
      })
    );
    const figure = screen.getByTestId("figure");
    expect(element(screen.getByText("€12,400")).className).toContain("font-mono");
    expect(figure.textContent).toContain("+€300");
    expect(figure.querySelector("svg.lucide-arrow-up")).not.toBeNull();
    expect(formatDelta).toHaveBeenCalledWith(300);
    expect(figure.className).toContain("items-end");
  });

  it("degrades bad props to the default figure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loose = markup(
      untyped("Figure", {
        value: "7",
        size: "huge",
        align: "middle",
        mono: "yes",
        unit: { not: "a node" },
        formatDelta: "nope",
        delta: Number.NaN,
      })
    );
    warn.mockRestore();
    expect(loose).toBe(markup(createElement(kit.Figure, { value: "7" })));
  });
});

describe("StatCard identity props", () => {
  function stat(props: Record<string, unknown>) {
    render(
      untyped("StatCard", { label: "Spend", value: "€2,140", "data-testid": "stat", ...props })
    );
    return screen.getByTestId("stat");
  }

  it("renders exactly as before when the new props are left out or set to their defaults", () => {
    const base = {
      label: "Spend",
      value: "€2,140",
      hint: "This month",
      delta: -3,
      tone: "warning",
    };
    expect(
      markup(untyped("StatCard", { ...base, size: "md", variant: "outline", hintLines: 1 }))
    ).toBe(markup(untyped("StatCard", base)));
    // And that default is the card as it was: a hairline outline with no fill,
    // a 20px figure, and a one-line hint.
    render(untyped("StatCard", { ...base, "data-testid": "legacy" }));
    const legacy = screen.getByTestId("legacy");
    expect(legacy.className).toBe(
      "flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] border border-border-default px-3 py-2.5"
    );
    expect(element(screen.getByText("€2,140")).className).toBe(
      "min-w-0 truncate text-xl font-semibold tabular-nums text-text-primary"
    );
    expect(element(screen.getByText("This month")).className).toBe(
      "min-w-0 truncate text-xs text-text-secondary"
    );
    cleanup();
    // Unknown values fall back to the same defaults.
    expect(
      markup(untyped("StatCard", { ...base, size: "xl", variant: "tile", hintLines: "lots" }))
    ).toBe(markup(untyped("StatCard", base)));
  });

  it("draws a larger figure at lg", () => {
    const md = element(stat({}).querySelector("span.font-semibold")).className;
    cleanup();
    const lg = element(stat({ size: "lg" }).querySelector("span.font-semibold")).className;
    expect(lg).not.toBe(md);
    expect(lg).toContain("text-2xl");
  });

  it("recesses a filled card, edging it in a caution tone while the figure stays neutral", () => {
    const outline = stat({}).className;
    cleanup();
    const filled = stat({ variant: "filled" });
    expect(filled.className).not.toBe(outline);
    expect(filled.className).toContain("bg-surface-inset");
    cleanup();
    for (const tone of ["warning", "error", "danger"] as const) {
      const card = stat({ variant: "filled", tone });
      expect(card.className).toContain(`border-status-${tone}`);
      expect(element(screen.getByText("€2,140")).className).not.toMatch(/status/);
      cleanup();
    }
    for (const tone of ["info", "success", "neutral"] as const) {
      expect(stat({ variant: "filled", tone }).className).not.toMatch(/border-status-/);
      cleanup();
    }
    expect(stat({ tone: "warning" }).className).not.toMatch(/border-status-/);
  });

  it("clamps the hint to the lines asked for, or lets it wrap", () => {
    const hintClass = (hintLines: unknown) => {
      stat({ hint: "Groceries, transport and the rest", hintLines });
      const value = element(screen.getByText("Groceries, transport and the rest")).className;
      cleanup();
      return value;
    };
    const clampedTo = (hintLines: unknown) => {
      stat({ hint: "Groceries, transport and the rest", hintLines });
      const hint = element(screen.getByText("Groceries, transport and the rest"));
      const lines = hint.className.includes("line-clamp-(--kit-hint-lines)")
        ? hint.style.getPropertyValue("--kit-hint-lines")
        : null;
      cleanup();
      return lines;
    };
    expect(hintClass(undefined)).toContain("truncate");
    expect(clampedTo(2)).toBe("2");
    expect(clampedTo(2.4)).toBe("2");
    expect(clampedTo(4)).toBe("4");
    expect(clampedTo(12)).toBe("12");
    const wrap = hintClass("wrap");
    expect(wrap).not.toMatch(/truncate|line-clamp/);
    expect(wrap).toContain("break-words");
    expect(hintClass(0)).toContain("truncate");
    expect(hintClass(-1)).toContain("truncate");
  });

  it("keeps the unit outside the figure's truncation, and sets a twin on its own line", () => {
    const card = stat({ unit: "/mo", twin: "≈ $2,300/mo" });
    const unit = element(screen.getByText("/mo"));
    const value = element(screen.getByText("€2,140"));
    expect(value.className).toContain("truncate");
    expect(value.contains(unit)).toBe(false);
    expect(unit.className).toContain("shrink-0");
    expect(unit.className).not.toContain("truncate");
    const twin = element(screen.getByText("≈ $2,300/mo"));
    expect(twin.tagName).toBe("P");
    expect(twin.className).toContain("tabular-nums");
    expect(card.textContent).toBe("Spend€2,140/mo≈ $2,300/mo");
  });
});

describe("DescriptionList alignment", () => {
  const items = [
    { label: "Rent", value: "€1,200" },
    { label: "Groceries", value: "€480" },
  ];

  function list(props: Record<string, unknown>) {
    const { container } = render(untyped("DescriptionList", { items, ...props }));
    return element(container.querySelector("dl"));
  }

  function tracks(dl: HTMLElement): string[] {
    return /grid-cols-\[([^\]]+)\]/.exec(dl.className)?.[1]?.split("_") ?? [];
  }

  it("keeps the default grid when neither prop is set or the values are invalid", () => {
    const plain = markup(untyped("DescriptionList", { items }));
    expect(markup(untyped("DescriptionList", { items, valueAlign: "start" }))).toBe(plain);
    expect(
      markup(untyped("DescriptionList", { items, valueAlign: "right", labelWidth: -40 }))
    ).toBe(plain);
    expect(markup(untyped("DescriptionList", { items, labelWidth: "" }))).toBe(plain);
  });

  it("ends values on the trailing edge with tabular digits", () => {
    const dl = list({ valueAlign: "end" });
    const template = tracks(dl);
    expect(template).toHaveLength(4);
    // The value track takes the free width, so values meet the trailing edge.
    expect(template[1]).toContain("1fr");
    expect(template[3]).not.toContain("fr");
    const value = element(screen.getByText("€480").parentElement);
    expect(value.className).toContain("text-end");
    expect(value.className).toContain("tabular-nums");
  });

  it("sets the label column's width in px or as a CSS length", () => {
    const px = list({ labelWidth: 140 });
    expect(px.style.getPropertyValue("--kit-dl-label")).toBe("140px");
    expect(tracks(px)[0]).toBe("var(--kit-dl-label)");
    cleanup();
    const both = list({ labelWidth: "12rem", valueAlign: "end" });
    expect(both.style.getPropertyValue("--kit-dl-label")).toBe("12rem");
    expect(tracks(both)[0]).toBe("var(--kit-dl-label)");
    expect(tracks(both)[1]).toContain("1fr");
  });

  it("leaves a stacked list alone", () => {
    const plain = markup(untyped("DescriptionList", { items, layout: "stacked" }));
    expect(
      markup(
        untyped("DescriptionList", { items, layout: "stacked", valueAlign: "end", labelWidth: 120 })
      )
    ).toBe(plain);
  });
});
