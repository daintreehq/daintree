// @vitest-environment jsdom
import { createElement, useState, type ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { PLUGIN_KIT_ICON_NAMES } from "@/components/PluginKit/PluginKitIcons";
import { avatarInitials } from "@/components/PluginKit/PluginKitOverlays";

// No separate Radix priming: readiness has to cover the primitives too, or
// the Select and Popover tests below would find nothing rendered.
beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function renderLoose<P extends object>(component: ComponentType<P>, looseProps: string) {
  const props: P = JSON.parse(looseProps);
  return render(createElement(component, props));
}

function withTooltips(child: ReturnType<typeof createElement>) {
  return createElement(TooltipProvider, null, child);
}

describe("@daintreehq/plugin-ui 1.2 readiness", () => {
  it("resolves whenPluginUiReady and renders synchronously after it", async () => {
    kit.preloadPluginUi();
    await expect(kit.whenPluginUiReady()).resolves.toBeUndefined();
    const { container } = render(createElement(kit.Button, { children: "Now" }));
    // No Suspense frame: the button is in the first commit.
    expect(container.querySelector("button")?.textContent).toBe("Now");
  });
});

describe("@daintreehq/plugin-ui 1.2 additions", () => {
  it("adds the icons the builtin migrations needed", () => {
    for (const name of [
      "user-plus",
      "chevrons-up-down",
      "wifi-off",
      "import",
      "rotate-cw",
      "unplug",
    ] as const) {
      expect(PLUGIN_KIT_ICON_NAMES).toContain(name);
      const { container } = render(createElement(kit.Icon, { name }));
      expect(container.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });

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
