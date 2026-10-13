// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

// Through the public specifier, the way a plugin view reaches it.
import * as kit from "@daintreehq/plugin-ui";
import { normalizeSelectOptions, pickDomProps } from "@/components/PluginKit/PluginKit";
import { avatarInitials } from "@/components/PluginKit/PluginKitOverlays";
import { PluginKitLayerContext, PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import { compareTreeNames } from "@/components/PluginKit/PluginKitFileTree";
import { FLEX_COLUMN_MAX_PX, layoutColumns } from "@/components/PluginKit/PluginKitLists";
import { sparklineRuns } from "@/components/PluginKit/PluginKitData";

// No separate Radix priming: readiness has to cover the primitives too, or
// the Select and Popover tests below would find nothing rendered.
beforeAll(async () => {
  await kit.whenPluginUiReady();
  // The kit's Markdown is lazy over a heavy renderer. Loaded cold on a busy CI
  // worker it can take longer than a waitFor allows; loaded here, the render
  // waits only on React.
  await import("@/components/Markdown/PluginMarkdown");
}, 60_000);

afterEach(cleanup);

// Written the way a zero-build view writes it. Parsed rather than typed: this
// is the untyped shape plain JavaScript sends.
function renderLoose<P extends object>(component: ComponentType<P>, looseProps: string) {
  const props: P = JSON.parse(looseProps);
  return render(createElement(component, props));
}

function withTooltips(child: ReturnType<typeof createElement>) {
  return createElement(TooltipProvider, null, child);
}

function inViewport(children: ReactNode, viewportHeight = 240) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight, itemHeight: 24 } },
    children
  );
}

function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="treeitem"]')].map(
    (row) => row.getAttribute("aria-label") ?? ""
  );
}

const ROOT = path.resolve(__dirname, "../../..");

/**
 * The `@daintreehq/plugin-ui` entry of `HOST_FACADE_REQUIRED_EXPORTS`, read
 * from source: the config is not importable from a test, and the host build
 * holds the facade to this list exactly.
 */
function facadeRequiredExports(): string[] {
  const config = readFileSync(path.join(ROOT, "vite.config.ts"), "utf-8");
  const table = config.slice(config.indexOf("const HOST_FACADE_REQUIRED_EXPORTS"));
  const entry = /"@daintreehq\/plugin-ui":\s*\[([^\]]*)\]/.exec(table);
  if (!entry) throw new Error("no @daintreehq/plugin-ui entry in HOST_FACADE_REQUIRED_EXPORTS");
  return [...entry[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/** Value exports (`export const` / `export function`) the published typings declare. */
function declaredValueExports(): string[] {
  const dts = readFileSync(path.join(ROOT, "packages/plugin-sdk/plugin-ui.d.ts"), "utf-8");
  const names = [
    ...dts.matchAll(/^\s*export\s+(?:declare\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]!);
  return [...new Set(names)];
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("@daintreehq/plugin-ui kit", () => {
  it("declares its contract version", () => {
    expect(kit.PLUGIN_UI_VERSION).toBe("1.0.0");
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

describe("@daintreehq/plugin-ui readiness", () => {
  it("resolves whenPluginUiReady and renders synchronously after it", async () => {
    kit.preloadPluginUi();
    await expect(kit.whenPluginUiReady()).resolves.toBeUndefined();
    const { container } = render(createElement(kit.Button, { children: "Now" }));
    // No Suspense frame: the button is in the first commit.
    expect(container.querySelector("button")?.textContent).toBe("Now");
  });
});

describe("@daintreehq/plugin-ui avatars, popovers and hints", () => {
  it("draws a pill Button", () => {
    render(createElement(kit.Button, { variant: "pill", children: "Preview" }));
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("data-variant")).toBe(
      "pill"
    );
  });

  it("takes date and time Input types and drops unknown ones", () => {
    render(createElement(kit.Input, { type: "date", "aria-label": "Due", value: "2026-09-30" }));
    expect(screen.getByLabelText("Due").getAttribute("type")).toBe("date");
    cleanup();
    renderLoose(kit.Input, '{"type":"file","aria-label":"Upload"}');
    expect(screen.getByLabelText("Upload").getAttribute("type")).toBe("text");
  });

  it("draws a compact Kbd with the chord's compact box", () => {
    const { container } = render(createElement(kit.Kbd, { density: "compact", children: "K" }));
    expect(container.querySelector("kbd")?.className).toContain("text-3xs");
  });

  it("returns a controlled Select to its placeholder when the value clears", () => {
    function Form() {
      const [value, setValue] = useState<string | null>("b");
      return createElement(
        "div",
        null,
        createElement(kit.Select, {
          "aria-label": "Branch",
          placeholder: "Pick one",
          value,
          onValueChange: setValue,
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta", icon: "git-branch" },
          ],
        }),
        createElement("button", { type: "button", onClick: () => setValue(null) }, "Reset")
      );
    }
    render(createElement(Form));
    const trigger = screen.getByRole("combobox", { name: "Branch" });
    expect(trigger.textContent).toContain("Beta");
    // The option's glyph rides along in the trigger's mirrored text.
    expect(trigger.querySelector("svg.text-text-secondary")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(trigger.textContent).toContain("Pick one");
    expect(trigger.hasAttribute("data-placeholder")).toBe(true);
  });

  it("forwards Callout DOM props and draws a dismiss control", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      withTooltips(
        createElement(kit.Callout, {
          severity: "warning",
          role: "status",
          id: "note",
          "data-testid": "callout",
          "aria-label": "Sync warning",
          onDismiss,
          dismissLabel: "Dismiss warning",
          action: createElement(kit.Button, { children: "Retry" }),
          actionPlacement: "below",
          children: "Sync paused.",
        })
      )
    );
    const root = screen.getByTestId("callout");
    expect(root.getAttribute("role")).toBe("status");
    expect(root.id).toBe("note");
    expect(root.getAttribute("aria-label")).toBe("Sync warning");
    // Below: the action sits in the text column, not the trailing slot.
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.closest(".min-w-0")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-severity-glyph]")).not.toBeNull();
  });

  it("draws a Callout strip as the pane banner", () => {
    render(
      withTooltips(
        createElement(kit.Callout, {
          severity: "error",
          variant: "strip",
          title: "Couldn't load issues",
          children: "The forge didn't answer.",
          "data-testid": "strip",
          action: createElement(kit.Button, { children: "Retry" }),
        })
      )
    );
    const strip = screen.getByTestId("strip");
    expect(strip.hasAttribute("data-inline-status-banner")).toBe(true);
    expect(strip.textContent).toContain("Couldn't load issues");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps element content out of a strip's description paragraph", () => {
    render(
      withTooltips(
        createElement(kit.Callout, {
          severity: "warning",
          variant: "strip",
          title: "Draft isn't backed up",
          children: createElement("div", { "data-testid": "detail" }, "Copy it somewhere safe."),
        })
      )
    );
    expect(screen.getByTestId("detail").closest("p")).toBeNull();
  });

  it("puts ScrollShadow DOM props on the scrolling element", () => {
    render(
      createElement(kit.ScrollShadow, {
        id: "rows",
        role: "listbox",
        "aria-label": "Rows",
        tabIndex: 0,
        children: "row",
      })
    );
    const scroller = screen.getByRole("listbox", { name: "Rows" });
    expect(scroller.id).toBe("rows");
    expect(scroller.className).toContain("overflow-y-auto");
  });

  it("wraps a VirtualList in scroll shadows when asked", () => {
    const { container } = render(
      createElement(
        "div",
        { style: { height: 100 } },
        createElement(kit.VirtualList, {
          "aria-label": "Runs",
          count: 3,
          shadows: true,
          renderItem: (index: number) => `Run ${index}`,
        })
      )
    );
    expect(container.querySelector(".relative.h-full.min-h-0")).not.toBeNull();
  });

  it("offers a radio group in a DropdownMenu and keeps its events off the view", async () => {
    const onValueChange = vi.fn();
    const onRowClick = vi.fn();
    render(
      createElement(
        "div",
        { onClick: onRowClick },
        createElement(kit.DropdownMenu, {
          open: true,
          stopPropagation: true,
          trigger: createElement(kit.Button, { children: "Sort" }),
          items: [
            {
              type: "radio-group",
              label: "Sort by",
              value: "updated",
              onValueChange,
              items: [
                { value: "updated", label: "Recently updated" },
                { value: "created", label: "Newest" },
                { value: "", label: "Dropped" },
              ],
            },
          ],
        })
      )
    );
    const radios = await screen.findAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Recently updated", "Newest"]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radios[1]!);
    expect(onValueChange).toHaveBeenCalledWith("created");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("stacks a nested Dialog, passes its test id and renders a custom footer", async () => {
    render(
      createElement(kit.Dialog, {
        open: true,
        onClose: () => {},
        title: "Create worktrees",
        icon: createElement(kit.Spinner, { size: "lg" }),
        layer: "nested",
        "data-testid": "bulk",
        hint: "3 issues",
        footer: createElement(kit.Button, { variant: "contrast", icon: "check", children: "Done" }),
      })
    );
    const dialog = await screen.findByTestId("bulk");
    expect(dialog).toBeTruthy();
    expect(document.querySelector("[data-dialog-title-icon] .animate-spin")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByTestId("app-dialog-hint").textContent).toBe("3 issues");
  });

  it("explains a disabled Dialog action and draws its icon", async () => {
    const onClick = vi.fn();
    render(
      createElement(kit.Dialog, {
        open: true,
        onClose: () => {},
        title: "Export",
        primaryAction: {
          label: "Export",
          icon: "download",
          onClick,
          disabled: true,
          disabledReason: "Pick a format first",
        },
      })
    );
    const button = await screen.findByRole("button", { name: "Export" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("svg")).not.toBeNull();
    const hint = screen.getByTestId("app-dialog-hint");
    expect(hint.textContent).toBe("Pick a format first");
    expect(button.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("gives a ConfirmDialog a hint", async () => {
    render(
      createElement(kit.ConfirmDialog, {
        open: true,
        onClose: () => {},
        onConfirm: () => {},
        title: "Reset?",
        confirmLabel: "Reset settings",
        hint: "Takes effect now",
        layer: "nested",
      })
    );
    expect((await screen.findByTestId("app-dialog-hint")).textContent).toBe("Takes effect now");
  });

  it("draws an Avatar's initials when there is no picture", () => {
    const { container } = render(createElement(kit.Avatar, { name: "Ada Lovelace", size: "md" }));
    expect(screen.getByRole("img", { name: "Ada Lovelace" })).toBeTruthy();
    expect(container.textContent).toBe("AL");
    // A text baseline through its middle, from generated content only, so it
    // lines up with the text beside it instead of sitting on the baseline.
    const root = container.firstElementChild!;
    expect(root.getAttribute("data-avatar-strut")).toBe("\u200B");
    expect(root.className).toContain("inline-flex");
    expect(root.className).toContain("items-center");
    expect(root.className).toContain("after:content-[attr(data-avatar-strut)]");
    expect(root.className).not.toContain("inline-block");
    expect(avatarInitials("@dependabot[bot]", 1)).toBe("D");
    expect(avatarInitials("octocat")).toBe("O");
    expect(avatarInitials("   ")).toBe("");
  });

  it("opens a Popover from its trigger with the plugin's content", async () => {
    render(
      createElement(kit.Popover, {
        trigger: createElement(kit.Button, { children: "Filter" }),
        "aria-label": "Filter issues",
        padding: "none",
        children: createElement(kit.PopoverSearchField, {
          value: "",
          "aria-label": "Search labels",
        }),
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    });
    const field = await screen.findByRole("textbox", { name: "Search labels" });
    expect(field.closest("[data-daintree-plugin-style-root]")).not.toBeNull();
  });

  it("renders a SkeletonHint's live region before the first hint", () => {
    const { container } = render(createElement(kit.SkeletonHint, { message: "Fetching" }));
    expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
  });

  it("passes TruncatedTooltip's isTruncated and SkeletonBone's immediate through", () => {
    render(
      withTooltips(
        createElement(kit.TruncatedTooltip, {
          content: "/a/very/long/path",
          isTruncated: true,
          children: createElement("span", { "data-testid": "path" }, "/a/…/path"),
        })
      )
    );
    // Forced truncated, the text becomes a focusable tooltip trigger.
    expect(screen.getByTestId("path").getAttribute("tabindex")).toBe("0");
    const { container } = render(createElement(kit.SkeletonBone, { immediate: true }));
    expect(container.querySelector(".animate-pulse-immediate")).not.toBeNull();
  });
});

const NESTED_OVERLAY_Z = "z-[calc(var(--z-nested-dialog)+1)]";
// Past Radix's deferred listener registration (a zero-delay timer).
const RADIX_ARM_MS = 10;
// Past the host tooltip's open delay.
const TOOLTIP_OPEN_MS = 3000;
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, RADIX_ARM_MS))));

describe("@daintreehq/plugin-ui overlay isolation, layering and ownership", () => {
  it("still closes on the first outside press after a press inside an isolated menu", async () => {
    const onRowPointerDown = vi.fn();
    function Row() {
      const [open, setOpen] = useState(true);
      return createElement(
        "div",
        { onPointerDown: onRowPointerDown },
        createElement(kit.DropdownMenu, {
          open,
          onOpenChange: setOpen,
          stopPropagation: true,
          trigger: createElement(kit.Button, { children: "Actions" }),
          items: [
            { type: "label", label: "Row actions" },
            { label: "Rename", onSelect: () => {} },
          ],
        })
      );
    }
    render(createElement(Row));
    const menu = await screen.findByRole("menu");
    // Radix arms its document listener a task after opening.
    await tick();
    fireEvent.pointerDown(screen.getByText("Row actions"));
    fireEvent.pointerDown(menu);
    expect(onRowPointerDown).not.toHaveBeenCalled();
    await tick();

    await act(async () => {
      fireEvent.pointerDown(document.body);
      fireEvent.pointerUp(document.body);
      fireEvent.click(document.body);
    });
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  const overlays = {
    menu: () =>
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Menu" }),
        items: [{ label: "One", onSelect: () => {} }],
      }),
    popover: () =>
      createElement(kit.Popover, {
        open: true,
        "aria-label": "Details",
        trigger: createElement(kit.Button, { children: "Details" }),
        children: createElement("span", { "data-testid": "popover-body" }, "Body"),
      }),
    select: () =>
      createElement(kit.Select, {
        "aria-label": "Pick",
        options: [{ value: "a", label: "Alpha" }],
      }),
  };

  function inNestedDialog(child: ReturnType<typeof createElement>) {
    return createElement(kit.Dialog, {
      open: true,
      onClose: () => {},
      title: "Nested",
      layer: "nested",
      children: child,
    });
  }

  it("stacks a DropdownMenu opened inside a nested Dialog above it", async () => {
    render(inNestedDialog(overlays.menu()));
    const menu = await screen.findByRole("menu", { hidden: true });
    expect(menu.className).toContain(NESTED_OVERLAY_Z);
    expect(menu.className).not.toContain("z-[var(--z-popover)]");
  });

  it("stacks a Popover opened inside a nested Dialog above it", async () => {
    render(inNestedDialog(overlays.popover()));
    const body = await screen.findByTestId("popover-body");
    const content = body.closest("[data-radix-popper-content-wrapper] > *");
    expect(content?.className).toContain(NESTED_OVERLAY_Z);
  });

  it("stacks a Select opened inside a nested Dialog above it", async () => {
    render(inNestedDialog(overlays.select()));
    const trigger = await screen.findByRole("combobox", { name: "Pick", hidden: true });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const listbox = await screen.findByRole("listbox", { hidden: true });
    expect(listbox.closest(`[class*="${NESTED_OVERLAY_Z}"]`)).not.toBeNull();
  });

  // In the nested layer directly: opening the dialog dismisses tooltips.
  it("stacks a TruncatedTooltip in a nested Dialog's layer above it", async () => {
    render(
      withTooltips(
        createElement(
          PluginKitLayerContext.Provider,
          { value: "nested" },
          createElement(kit.TruncatedTooltip, {
            content: "/a/very/long/path",
            isTruncated: true,
            children: createElement("span", { "data-testid": "path" }, "/a/…/path"),
          })
        )
      )
    );
    const path = await screen.findByTestId("path");
    await act(async () => {
      fireEvent.pointerMove(path, { pointerType: "mouse" });
    });
    const tip = await screen.findByRole("tooltip", { hidden: true }, { timeout: TOOLTIP_OPEN_MS });
    expect(tip.closest(`[class*="${NESTED_OVERLAY_Z}"]`)).not.toBeNull();
  });

  it("stacks overlays in a nested ConfirmDialog's description above it", async () => {
    render(
      createElement(kit.ConfirmDialog, {
        open: true,
        onClose: () => {},
        onConfirm: () => {},
        title: "Reset?",
        confirmLabel: "Reset",
        layer: "nested",
        description: createElement(kit.DropdownMenu, {
          open: true,
          trigger: createElement(kit.Button, { children: "Scope" }),
          items: [{ label: "All", onSelect: () => {} }],
        }),
      })
    );
    const menu = await screen.findByRole("menu", { hidden: true });
    expect(menu.className).toContain(NESTED_OVERLAY_Z);
  });

  it("leaves overlays outside a nested Dialog at the popover tier", async () => {
    render(overlays.menu());
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("z-[var(--z-popover)]");
    expect(menu.className).not.toContain(NESTED_OVERLAY_Z);
  });

  const OWNER = "data-daintree-plugin-owner";
  function owned(child: ReturnType<typeof createElement>) {
    return createElement(PluginKitOwnerContext.Provider, { value: "acme.demo" }, child);
  }

  it("stamps the owning plugin on a DropdownMenu's content", async () => {
    render(owned(overlays.menu()));
    expect((await screen.findByRole("menu")).getAttribute(OWNER)).toBe("acme.demo");
  });

  it("stamps the owning plugin on a Popover's content and its style root", async () => {
    render(owned(overlays.popover()));
    const body = await screen.findByTestId("popover-body");
    expect(body.closest("[data-daintree-plugin-style-root]")?.getAttribute(OWNER)).toBe(
      "acme.demo"
    );
    expect(body.closest("[data-radix-popper-content-wrapper] > *")?.getAttribute(OWNER)).toBe(
      "acme.demo"
    );
  });

  it("attributes input inside a Dialog body to the owning plugin", async () => {
    render(
      owned(
        createElement(kit.Dialog, {
          open: true,
          onClose: () => {},
          title: "Owned",
          children: createElement("input", { "aria-label": "Name" }),
        })
      )
    );
    const input = await screen.findByRole("textbox", { name: "Name" });
    expect(input.closest(`[${OWNER}]`)?.getAttribute(OWNER)).toBe("acme.demo");
  });
});

describe("FileTree", () => {
  it("orders folders first, then numeric-aware and case-insensitive names", () => {
    const names = ["churn-10.txt", "churn-2.txt", "README.md", "alpha.ts", "Beta.ts"];
    const sorted = names
      .map((name) => ({ name, isDirectory: false }))
      .concat([{ name: "src", isDirectory: true }])
      .sort(compareTreeNames)
      .map((entry) => entry.name);
    expect(sorted).toEqual([
      "src",
      "alpha.ts",
      "Beta.ts",
      "churn-2.txt",
      "churn-10.txt",
      "README.md",
    ]);
  });

  it("builds the tree from a walk-shaped flat list and fills in missing folders", () => {
    const { container } = render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          entries: [
            { path: "churn-10.txt", type: "file" },
            { path: "churn-2.txt", type: "file" },
            { path: "src/deep/index.ts", type: "file" },
            { path: "docs", type: "dir" },
          ],
          defaultExpandedPaths: ["src"],
        })
      )
    );
    expect(rowNames(container)).toEqual(["docs", "src", "deep", "churn-2.txt", "churn-10.txt"]);
    const src = screen.getByRole("treeitem", { name: "src" });
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(src.getAttribute("aria-level")).toBe("1");
    expect(screen.getByRole("treeitem", { name: "deep" }).getAttribute("aria-level")).toBe("2");
    expect(
      screen.getByRole("treeitem", { name: "churn-2.txt" }).getAttribute("aria-posinset")
    ).toBe("3");
  });

  it("keeps the input order with sort='none'", () => {
    const { container } = render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          sort: "none",
          entries: [
            { path: "b.txt", type: "file" },
            { path: "a.txt", type: "file" },
          ],
        })
      )
    );
    expect(rowNames(container)).toEqual(["b.txt", "a.txt"]);
  });

  it("gives files the chevron gutter so their icons line up with folders'", () => {
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }, { name: "b.ts" }],
        })
      )
    );
    const file = screen.getByRole("treeitem", { name: "b.ts" });
    expect(file.firstElementChild?.hasAttribute("data-file-tree-gutter")).toBe(true);
    const folder = screen.getByRole("treeitem", { name: "src" });
    expect(folder.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(folder.firstElementChild?.className).toContain("w-4");
  });

  it("drops the gutter when there are no folders at all", () => {
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          entries: [{ path: "a.ts", type: "file" }],
        })
      )
    );
    const file = screen.getByRole("treeitem", { name: "a.ts" });
    expect(file.querySelector("[data-file-tree-gutter]")).toBeNull();
  });

  it("drives selection and expansion from the keyboard", () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [
            { name: "src", children: [{ name: "a.ts" }, { name: "b.ts" }] },
            { name: "zeta.md" },
          ],
          onSelect,
          onActivate,
        })
      )
    );
    const tree = screen.getByRole("tree", { name: "Files" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("src", {
      path: "src",
      name: "src",
      type: "directory",
      depth: 0,
    });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("src/a.ts", expect.objectContaining({ depth: 1 }));
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("src", expect.anything());
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(screen.queryByRole("treeitem", { name: "a.ts" })).toBeNull();
    fireEvent.keyDown(tree, { key: "z" });
    expect(onSelect).toHaveBeenLastCalledWith("zeta.md", expect.anything());
    expect(screen.getByRole("treeitem", { name: "zeta.md" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("zeta.md", expect.objectContaining({ type: "file" }));
    fireEvent.keyDown(tree, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("src", expect.anything());
  });

  it("toggles from the chevron without moving the selection", () => {
    const onSelect = vi.fn();
    render(
      inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }],
          onSelect,
        })
      )
    );
    const folder = screen.getByRole("treeitem", { name: "src" });
    const chevron = folder.firstElementChild;
    if (!chevron) throw new Error("no chevron");
    fireEvent.click(chevron);
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("treeitem", { name: "a.ts" }));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts", expect.anything());
  });

  it("follows controlled selection and expansion", () => {
    function Controlled() {
      const [expanded, setExpanded] = useState<string[]>([]);
      return inViewport(
        createElement(kit.FileTree, {
          "aria-label": "Files",
          nodes: [{ name: "src", children: [{ name: "a.ts" }] }],
          selectedPath: "src",
          expandedPaths: expanded,
          onExpandedPathsChange: setExpanded,
        })
      );
    }
    render(createElement(Controlled));
    const tree = screen.getByRole("tree");
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "a.ts" })).not.toBeNull();
    // Selection is controlled and never changed, so the cursor stays put.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("mounts a bounded window of a 10k-file tree in natural order", () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => ({
      path: `file-${9_999 - i}.txt`,
      type: "file" as const,
    }));
    const { container } = render(
      inViewport(createElement(kit.FileTree, { "aria-label": "Files", entries }))
    );
    const rows = rowNames(container);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows.slice(0, 3)).toEqual(["file-0.txt", "file-1.txt", "file-2.txt"]);
    expect(container.querySelectorAll("*").length).toBeLessThan(1500);
  });

  it("shows `empty` when there is nothing to list", () => {
    render(
      createElement(kit.FileTree, {
        "aria-label": "Files",
        entries: [],
        empty: createElement("p", null, "No files"),
      })
    );
    expect(screen.getByText("No files")).not.toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });
});

describe("StatCard and Sparkline", () => {
  it("draws a sentence-case label, the figure and a signed delta without accent", () => {
    const { container } = render(
      createElement(kit.StatCard, {
        label: "Changed files",
        value: "43",
        delta: -2,
        hint: "2 worktrees",
        "data-testid": "stat",
      })
    );
    const card = screen.getByTestId("stat");
    expect(card.textContent).toContain("Changed files");
    expect(card.textContent).toContain("43");
    expect(card.textContent).toContain("−2");
    expect(card.textContent).toContain("2 worktrees");
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-|accent/);
  });

  it("words a number delta with formatDelta and keeps the sign and arrow", () => {
    const formatDelta = vi.fn((magnitude: number) => `${magnitude.toFixed(1)}%`);
    render(
      createElement(
        "div",
        null,
        createElement(kit.StatCard, {
          label: "MRR",
          value: "$25,901",
          delta: 12.5,
          formatDelta,
          "data-testid": "up",
        }),
        createElement(kit.StatCard, {
          label: "Churn",
          value: "2%",
          delta: -3,
          formatDelta,
          "data-testid": "down",
        }),
        createElement(kit.StatCard, {
          label: "Seats",
          value: 40,
          delta: 0,
          formatDelta,
          "data-testid": "flat",
        })
      )
    );
    // The formatter only ever sees the magnitude; the card owns the sign.
    expect(formatDelta.mock.calls.map(([magnitude]) => magnitude)).toEqual([12.5, 3, 0]);
    const up = screen.getByTestId("up");
    expect(up.textContent).toContain("+12.5%");
    expect(up.querySelector("svg.lucide-arrow-up")).not.toBeNull();
    const down = screen.getByTestId("down");
    expect(down.textContent).toContain("\u22123.0%");
    expect(down.querySelector("svg.lucide-arrow-down")).not.toBeNull();
    const flat = screen.getByTestId("flat");
    expect(flat.textContent).toContain("0.0%");
    expect(flat.querySelector("svg.lucide-arrow-up, svg.lucide-arrow-down")).toBeNull();
  });

  it("falls back to the grouped number when formatDelta returns no string", () => {
    const formatDelta: (magnitude: number) => string = JSON.parse("null") ?? (() => 7);
    render(
      createElement(kit.StatCard, {
        label: "Events",
        value: 1,
        delta: 1234,
        formatDelta,
        "data-testid": "stat",
      })
    );
    expect(screen.getByTestId("stat").textContent).toContain("+1,234");
  });

  it("marks a toned stat with its severity glyph and word", () => {
    render(createElement(kit.StatCard, { label: "Errors", value: 3, tone: "error" }));
    expect(screen.getByText("Error:", { exact: false }).className).toContain("sr-only");
    expect(document.querySelector('svg[class*="text-status-"]')).not.toBeNull();
  });

  it("scales a sparkline into its box, splitting at gaps", () => {
    const runs = sparklineRuns([0, 10, Number.NaN, 5, 5], 24);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(2);
    // The floor and ceiling stay inside the dot's inset.
    expect(runs[0]?.[0]).toBe("0.00,22.00");
    expect(runs[0]?.[1]).toBe("25.00,2.00");
    expect(sparklineRuns([7], 24)).toEqual([]);
  });

  it("scales a series too long to spread into Math.min", () => {
    const values = Array.from({ length: 300_000 }, (_, index) => index % 100);
    const runs = sparklineRuns(values, 24);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(300_000);
  });

  it("draws the newest-value dot only when the final sample is present", () => {
    const { container } = render(
      createElement(kit.Sparkline, { values: [1, 2, Number.NaN], "aria-label": "Gap" })
    );
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(container.querySelector("[data-sparkline-dot]")).toBeNull();
    cleanup();
    const { container: present } = render(
      createElement(kit.Sparkline, { values: [1, Number.NaN, 2, 3], "aria-label": "Recovered" })
    );
    expect(present.querySelector("[data-sparkline-dot]")).not.toBeNull();
  });

  it("renders a labelled SVG trend in a theme colour, never accent", () => {
    const { container } = render(
      createElement(kit.Sparkline, { values: [1, 3, 2], "aria-label": "Events", height: 32 })
    );
    const svg = screen.getByRole("img", { name: "Events" });
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("class")).toContain("text-text-secondary");
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(container.querySelector("[data-sparkline-dot]")).not.toBeNull();
    cleanup();
    const { container: toned } = render(
      createElement(kit.Sparkline, { values: [1, 2], "aria-label": "", tone: "warning" })
    );
    const hidden = toned.querySelector("svg");
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    expect(hidden?.getAttribute("class")).toContain("text-status-warning");
  });
});

describe("kit polish", () => {
  it("labels a group of controls at a field label's size", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(kit.FormField, { label: "Title", children: createElement(kit.Input, {}) }),
        createElement(
          kit.FormFieldGroup,
          { label: "Labels", required: true, description: "Pick any", layout: "inline" },
          createElement(kit.FormField, {
            label: "bug",
            orientation: "horizontal",
            children: createElement(kit.Checkbox, {}),
          })
        )
      )
    );
    const group = screen.getByRole("group", { name: "Labels" });
    expect(group.tagName).toBe("FIELDSET");
    const described = (group.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Required", "Pick any"]);
    const fieldLabel = container.querySelector("label[for]");
    const groupLabel = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    const sizeOf = (el: Element | null | undefined) =>
      (el?.className ?? "").split(" ").filter((c) => /^text-(xs|sm|base)$/.test(c));
    expect(sizeOf(groupLabel)).toEqual(sizeOf(fieldLabel));
    expect(screen.getByRole("checkbox", { name: "bug" })).not.toBeNull();
  });

  it("disables every control in a disabled group", () => {
    render(
      createElement(
        kit.FormFieldGroup,
        { label: "Labels", disabled: true },
        createElement(kit.Checkbox, { "aria-label": "bug" })
      )
    );
    expect((screen.getByRole("group") as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("fills and centres a canvas EmptyState in its container", () => {
    const { container } = render(createElement(kit.EmptyState, { title: "Select a note" }));
    const root = container.querySelector("[role=status], div");
    expect(root?.className).toMatch(/\bflex-1\b/);
    expect(root?.className).toMatch(/\bh-full\b/);
    cleanup();
    const { container: narrow } = render(
      createElement(kit.EmptyState, { title: "None", scale: "sidebar" })
    );
    expect(narrow.querySelector("div")?.className).not.toMatch(/\bflex-1\b/);
  });

  it("caps unsized DataTable columns and keeps sized ones exact", () => {
    const sized = [
      { width: 64, grow: false },
      { width: undefined, grow: false },
      { width: 112, grow: false },
    ];
    expect(layoutColumns(sized, 1560)).toEqual({
      widths: [64, FLEX_COLUMN_MAX_PX, 112],
      filler: true,
    });
    // Narrow enough that the share is under the cap: the plain share, no filler.
    expect(layoutColumns(sized, 500)).toEqual({ widths: [64, undefined, 112], filler: false });
    // Every column sized: exactly those widths, the rest left as trailing space.
    expect(layoutColumns([{ width: 80, grow: false }], 1000).filler).toBe(true);
    // `grow` opts one column into everything left.
    expect(
      layoutColumns(
        [
          { width: 64, grow: false },
          { width: undefined, grow: true },
        ],
        1560
      )
    ).toEqual({ widths: [64, undefined], filler: false });
    // Unmeasured: the fixed-layout share.
    expect(layoutColumns(sized, null).filler).toBe(false);
    // A px string sums like a number; a relative length cannot be summed.
    const pxString = [
      { width: "120px", grow: false },
      { width: undefined, grow: false },
    ];
    expect(layoutColumns(pxString, 1560)).toEqual({
      widths: ["120px", FLEX_COLUMN_MAX_PX],
      filler: true,
    });
    expect(
      layoutColumns(
        [
          { width: "20%", grow: false },
          { width: undefined, grow: false },
        ],
        1560
      ).filler
    ).toBe(false);
    // `grow` on a sized column has nothing to take, so the cap still applies.
    expect(
      layoutColumns(
        [
          { width: 64, grow: true },
          { width: undefined, grow: false },
        ],
        1560
      ).filler
    ).toBe(true);
  });

  it("draws the DataTable filler as an unlabelled trailing cell", () => {
    const { container } = render(
      inViewport(
        createElement(kit.DataTable<{ id: string }>, {
          "aria-label": "Ids",
          rows: [{ id: "a" }],
          rowKey: "id",
          columns: [{ id: "id", header: "Id", width: 80 }],
        })
      )
    );
    const headers = container.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    expect(headers[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(container.querySelector("tbody td[aria-hidden=true]")).not.toBeNull();
  });

  it("aligns Markdown to the leading edge on request", async () => {
    const { container } = render(
      createElement(kit.Markdown, { source: "Hello", align: "start", className: "px-3" })
    );
    await vi.waitFor(() => {
      if (!container.querySelector(".markdown-document")) throw new Error("not rendered");
    });
    const doc = container.querySelector(".markdown-document");
    expect(doc?.className).toContain("mx-0!");
    expect(doc?.className).toContain("px-3");
    cleanup();
    const { container: centred } = render(createElement(kit.Markdown, { source: "Hello" }));
    await vi.waitFor(() => {
      if (!centred.querySelector(".markdown-document")) throw new Error("not rendered");
    });
    expect(centred.querySelector(".markdown-document")?.className).not.toContain("mx-0!");
  });
});

describe("CopyButton with a label", () => {
  it("keeps the label beside its glyph, with the spare slot width after it", () => {
    render(
      createElement(kit.CopyButton, {
        text: "log",
        label: "Copy log",
        size: "sm",
        className: "ml-auto",
      })
    );
    const button = screen.getByRole("button", { name: "Copy log" });
    // The button's own gap between glyph and label, and nothing else between them.
    expect(button.className).toContain("gap-1.5");
    expect(button.className).toContain("text-left");
    expect(button.className).toContain("ml-auto");
    expect(button.className).not.toMatch(/\b(?:w-full|flex-1|justify-between)\b/);
    const content = button.querySelector('[data-slot="button-content"]') ?? button;
    const [glyph, slot] = [...content.children];
    expect(glyph?.tagName.toLowerCase()).toBe("svg");
    expect(slot?.tagName.toLowerCase()).toBe("span");
    expect(slot?.firstElementChild?.textContent).toBe("Copy log");
  });

  it("leaves the icon-only form as it was", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.CopyButton, { text: "log", "aria-label": "Copy log" })
      )
    );
    expect(screen.getByRole("button", { name: "Copy log" }).className).not.toContain("text-left");
  });
});

describe("@daintreehq/plugin-ui facade exports", () => {
  it("lists each required export once", () => {
    const required = facadeRequiredExports();
    expect(new Set(required).size).toBe(required.length);
  });

  it("requires exactly the value exports the published typings declare", () => {
    expect(sorted(facadeRequiredExports())).toEqual(sorted(declaredValueExports()));
  });

  it("requires exactly the facade module's runtime exports", () => {
    expect(sorted(facadeRequiredExports())).toEqual(sorted(Object.keys(kit)));
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
    });
    vi.doUnmock("@/components/PluginKit/PluginKit");
    // React 19 can hold a resolved Suspense boundary's reveal for up to ~300ms,
    // so a single macrotask after the chunk settles is a race under CI load.
    await waitFor(() => expect(container.querySelector("button")?.textContent).toBe("Later"));
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
