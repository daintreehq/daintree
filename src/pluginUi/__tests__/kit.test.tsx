// @vitest-environment jsdom
import { createElement, type ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

// Through the public specifier, the way a plugin view reaches it.
import * as kit from "@daintreehq/plugin-ui";
import { normalizeSelectOptions, pickDomProps } from "@/components/PluginKit/PluginKit";
import { PLUGIN_KIT_ICON_NAMES } from "@/components/PluginKit/PluginKitIcons";

beforeAll(async () => {
  await primeRadix();
  // Resolve the kit chunk once so each test sees its first commit settled.
  render(createElement(kit.Spinner));
  await vi.waitFor(() => {
    if (!document.querySelector(".animate-spin")) throw new Error("kit not loaded");
  });
  cleanup();
});

afterEach(cleanup);

// Written the way a zero-build view writes it. Parsed rather than typed: this
// is the untyped shape plain JavaScript sends.
function renderLoose<P extends object>(component: ComponentType<P>, looseProps: string) {
  const props: P = JSON.parse(looseProps);
  return render(createElement(component, props));
}

describe("@daintreehq/plugin-ui kit", () => {
  it("declares its contract version", () => {
    expect(kit.PLUGIN_UI_VERSION).toBe("1.3.0");
  });

  it("renders a themed host Button and narrows what a view passes", () => {
    renderLoose(
      kit.Button,
      JSON.stringify({
        variant: "rainbow",
        size: "huge",
        className: "mt-2",
        "data-testid": "go",
        "aria-describedby": "hint",
        dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
        asChild: true,
        icon: "play",
        children: "Run",
      })
    );
    const button = screen.getByTestId("go");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("default");
    expect(button.getAttribute("aria-describedby")).toBe("hint");
    expect(button.className).toContain("mt-2");
    expect(button.textContent).toBe("Run");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.querySelector("img")).toBeNull();
  });

  it("drops node props React cannot render instead of crashing the view", () => {
    renderLoose(kit.Button, JSON.stringify({ "data-testid": "odd", children: { message: "Run" } }));
    expect(screen.getByTestId("odd").textContent).toBe("");
  });

  it("forwards a ref and click handler through the lazy boundary", () => {
    const onClick = vi.fn();
    let node: HTMLButtonElement | null = null;
    render(
      createElement(kit.Button, {
        onClick,
        ref: (el: HTMLButtonElement | null) => {
          node = el;
        },
        children: "Save",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(node).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("gives an IconButton its accessible name and an icon", () => {
    // The host's App provides this above every plugin view.
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.IconButton, { icon: "refresh", "aria-label": "Refresh" })
      )
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("renders Icon by name and nothing for an unknown one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      createElement("div", null, createElement(kit.Icon, { name: "git-branch", size: 20 }))
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");

    const unknown = renderLoose(kit.Icon, '{"name":"toString"}');
    expect(unknown.container.innerHTML).toBe("");
    renderLoose(kit.Icon, '{"name":"toString"}');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("names a labelled Icon for assistive tech", () => {
    render(createElement(kit.Icon, { name: "daintree", "aria-label": "Daintree" }));
    expect(screen.getByRole("img", { name: "Daintree" })).toBeTruthy();
  });

  it("serves a curated icon set", () => {
    expect(PLUGIN_KIT_ICON_NAMES.length).toBeGreaterThanOrEqual(60);
    expect(PLUGIN_KIT_ICON_NAMES.length).toBeLessThanOrEqual(160);
    for (const name of PLUGIN_KIT_ICON_NAMES) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("renders a Badge, Kbd and KbdChord", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(kit.Badge, { tone: "success", children: "Passing" }),
        createElement(kit.Kbd, { children: "Esc" }),
        createElement(kit.KbdChord, { shortcut: "Cmd+K", "aria-label": "Command K" })
      )
    );
    expect(container.querySelector("[data-slot='badge']")?.getAttribute("data-tone")).toBe(
      "success"
    );
    expect(container.querySelector("kbd")?.textContent).toBe("Esc");
    expect(container.textContent).toContain("Command K");
  });

  it("renders Badge tone danger as the same pill as error", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(kit.Badge, { tone: "danger", children: "Failing" }),
        createElement(kit.Badge, { tone: "error", children: "Failing" })
      )
    );
    const [danger, error] = container.querySelectorAll("[data-slot='badge']");
    expect(danger?.getAttribute("data-tone")).toBe("error");
    expect(danger?.className).toBe(error?.className);
  });

  it("reports Checkbox changes as booleans", () => {
    const onCheckedChange = vi.fn();
    render(createElement(kit.Checkbox, { "aria-label": "Include", onCheckedChange }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("gives Input and Textarea an onValueChange beside the native event", () => {
    const onChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      createElement(
        "div",
        null,
        // @ts-expect-error a file input is not one the kit offers
        createElement(kit.Input, { "aria-label": "Name", onChange, onValueChange, type: "file" }),
        createElement(kit.Textarea, { "aria-label": "Notes", onValueChange })
      )
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    // A file input is not a text field the kit offers.
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.change(input, { target: { value: "ana" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls).toEqual([["ana"], ["hi"]]);
  });

  it("clears a SearchField through onClear", () => {
    const onClear = vi.fn();
    render(
      createElement(kit.SearchField, {
        "aria-label": "Filter",
        value: "abc",
        onValueChange: () => {},
        onClear,
        className: "w-40",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".search-field")?.className).toContain("w-40");
  });

  it("picks one SegmentedControl option", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.SegmentedControl, {
        "aria-label": "Layout",
        value: "split",
        onValueChange,
        options: [
          { value: "split", label: "Split" },
          { value: "unified", label: "Unified" },
          { value: "split", label: "Duplicate" },
          // @ts-expect-error the untyped shape a JavaScript view can send
          { label: "No value" },
        ],
      })
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Split", "Unified"]);
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(onValueChange).toHaveBeenCalledWith("unified");
  });

  it("drops a description the host only allows at canvas scale", () => {
    const { container } = render(
      createElement(kit.EmptyState, {
        title: "No runs",
        scale: "sidebar",
        description: "Runs appear here",
        icon: "workflow",
      })
    );
    expect(container.textContent).toContain("No runs");
    expect(container.textContent).not.toContain("Runs appear here");
    expect(container.querySelector("[data-empty-state-icon] svg")).not.toBeNull();
  });

  it("renders a Callout with its severity glyph", () => {
    const { container } = render(
      createElement(kit.Callout, { severity: "warning", title: "Heads up", children: "Body" })
    );
    expect(container.querySelector("[data-callout='warning']")).not.toBeNull();
    expect(container.querySelector("[data-severity-glyph]")).not.toBeNull();
  });

  it("renders the Skeleton family as one status region", () => {
    const { container } = render(
      createElement(
        kit.Skeleton,
        { label: "Loading runs" },
        createElement(kit.SkeletonBone, { heightPx: 12 }),
        createElement(kit.SkeletonText, { lines: 2 })
      )
    );
    expect(screen.getByRole("status", { name: "Loading runs" })).toBeTruthy();
    expect(container.querySelectorAll("[data-skeleton-bone]")).toHaveLength(3);
  });

  it("wraps content in a ScrollShadow scroller", () => {
    const { container } = render(
      createElement(kit.ScrollShadow, { scrollClassName: "p-2", children: "rows" })
    );
    expect(container.querySelector(".overflow-y-auto")?.className).toContain("p-2");
  });

  it("opens a DropdownMenu from a kit Button trigger", async () => {
    const onSelect = vi.fn();
    render(
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Actions" }),
        items: [
          { label: "Rename", icon: "pencil", onSelect, shortcut: "Cmd+R" },
          { type: "separator" },
          { type: "label", label: "Danger" },
          { label: "Delete", destructive: true, onSelect: () => {} },
          // @ts-expect-error the untyped shape a JavaScript view can send
          { type: "bogus", label: "Ignored" },
          // @ts-expect-error the untyped shape a JavaScript view can send
          null,
        ],
      })
    );
    // The open menu is modal, so the trigger behind it is aria-hidden.
    const trigger = await screen.findByRole("button", { name: "Actions", hidden: true });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = await screen.findAllByRole("menuitem");
    expect(
      items.map((item) => (item.textContent?.startsWith("Rename") ? "Rename" : item.textContent))
    ).toEqual(["Rename", "Delete"]);
    fireEvent.click(items[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("confirms through ConfirmDialog", async () => {
    const onConfirm = vi.fn();
    render(
      createElement(kit.ConfirmDialog, {
        open: true,
        onClose: () => {},
        onConfirm,
        title: "Delete run?",
        confirmLabel: "Delete run",
        variant: "destructive",
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete run" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders a Dialog with its actions", async () => {
    const onClick = vi.fn();
    render(
      createElement(kit.Dialog, {
        open: true,
        onClose: () => {},
        title: "Export",
        description: "Pick a format.",
        primaryAction: { label: "Export", onClick },
        secondaryAction: { label: "Cancel", onClick: () => {} },
        // @ts-expect-error sizes are a closed set
        size: "enormous",
      })
    );
    const description = await screen.findByText("Pick a format.");
    // Portalled out of the view, so the plugin's scoped classes need the root re-marked.
    expect(description.closest("[data-daintree-plugin-style-root]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("@daintreehq/plugin-ui first render", () => {
  // A fresh module graph, so the kit chunk has never resolved. The render and
  // the wait both sit in an awaited act(), or React never retries the
  // suspended boundary under the test renderer.
  it("paints a Tooltip's trigger before the kit loads, and nothing for a Button", async () => {
    vi.resetModules();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    // Holds the kit chunk back until the first commit has been checked.
    vi.doMock("@/components/PluginKit/PluginKit", async (importOriginal) => {
      await gate;
      return importOriginal();
    });
    const fresh = await import("@daintreehq/plugin-ui");
    const tooltip = await import("@/components/ui/tooltip");
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        createElement(
          tooltip.TooltipProvider,
          null,
          createElement(fresh.Tooltip, {
            content: "More",
            children: createElement("span", { "data-testid": "trigger" }, "Hover"),
          }),
          createElement(fresh.Button, { children: "Later" })
        )
      ).container;
    });
    expect(container.querySelector("[data-testid='trigger']")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      openGate();
      await import("@/components/PluginKit/PluginKit");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.doUnmock("@/components/PluginKit/PluginKit");
    expect(container.querySelector("button")?.textContent).toBe("Later");
    expect(container.querySelector("[data-testid='trigger']")).not.toBeNull();
  }, 30_000);
});

describe("normalizeSelectOptions", () => {
  it("keeps valid options and groups, dropping empty, duplicate and malformed values", () => {
    expect(
      normalizeSelectOptions([
        { value: "a", label: "A" },
        { value: "", label: "Empty" },
        { value: "a", label: "Again" },
        { label: "Group", options: [{ value: "b", label: "B", disabled: true }, 7] },
        { label: "Empty group", options: [] },
        "c",
        null,
      ])
    ).toEqual([
      {
        kind: "option",
        option: { value: "a", label: "A", description: undefined, disabled: false },
      },
      {
        kind: "group",
        label: "Group",
        options: [{ value: "b", label: "B", description: undefined, disabled: true }],
      },
    ]);
    expect(normalizeSelectOptions("nope")).toEqual([]);
  });
});

describe("pickDomProps", () => {
  it("forwards only the DOM props the kit promises", () => {
    const handler = () => {};
    const ref = { current: null };
    expect(
      pickDomProps({
        id: "x",
        title: "t",
        tabIndex: 0,
        role: "status",
        style: { color: "red" },
        "aria-label": "Name",
        "data-state": "open",
        "data-object": { nope: true },
        onPointerDown: handler,
        onClick: "alert(1)",
        ref,
        dangerouslySetInnerHTML: { __html: "x" },
        asChild: true,
        className: "ignored-here",
        href: "javascript:alert(1)",
      })
    ).toEqual({
      id: "x",
      title: "t",
      tabIndex: 0,
      role: "status",
      style: { color: "red" },
      "aria-label": "Name",
      "data-state": "open",
      onPointerDown: handler,
      ref,
    });
  });
});
