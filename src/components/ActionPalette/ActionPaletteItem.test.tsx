// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ActionPaletteItem,
  HIDE_SHORTCUT,
  PIN_SHORTCUT,
  paletteSummary,
} from "./ActionPaletteItem";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import type { ReactNode } from "react";
import { KbdChord } from "@/components/ui/Kbd";

// The app root supplies the TooltipProvider. Triggers render inline; the
// content is left out so a disclosed label is not counted twice.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/config/categoryColors", () => ({
  ACTION_CATEGORY_COLORS: {
    terminal: "bg-category-blue-subtle text-category-blue-text border border-category-blue-border",
  },
  ACTION_CATEGORY_DEFAULT_COLOR: "bg-tint/[0.06] text-text-secondary",
}));

function describedIds(option: HTMLElement): string[] {
  return (option.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
}

/** The text each `aria-describedby` reference resolves to, in reading order. */
function describedTexts(option: HTMLElement): string[] {
  return describedIds(option).map((id) => document.getElementById(id)?.textContent ?? `#${id}`);
}

function labelText(option: HTMLElement): string {
  const id = option.getAttribute("aria-labelledby");
  return id ? (document.getElementById(id)?.textContent ?? "") : "";
}

function makeItem(overrides: Partial<ActionPaletteItemType> = {}): ActionPaletteItemType {
  return {
    id: "action-1",
    title: "Test Action",
    description: "Test description",
    category: "terminal",
    enabled: true,
    danger: "safe",
    kind: "command",
    titleLower: "test action",
    categoryLower: "terminal",
    descriptionLower: "test description",
    titleAcronym: "TA",
    keywordsLower: [],
    ...overrides,
  };
}

describe("ActionPaletteItem", () => {
  const onSelect = vi.fn();

  it("renders enabled action without disabled reason", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ enabled: true })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("Test Action")).toBeTruthy();
    expect(screen.getByText("Test description")).toBeTruthy();
    expect(screen.queryByText("No focused terminal")).toBeNull();
  });

  it("renders disabled action with inline disabled reason", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ enabled: false, disabledReason: "No focused terminal" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("Test Action")).toBeTruthy();
    expect(screen.getByText("Test description")).toBeTruthy();
    expect(screen.getByText("No focused terminal")).toBeTruthy();
  });

  it("does not render disabled reason for disabled actions without a reason", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ enabled: false })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("Test Action")).toBeTruthy();
    expect(screen.getByText("Test description")).toBeTruthy();
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe("true");
  });

  it("does not render disabled reason for enabled actions with disabledReason", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ enabled: true, disabledReason: "Should not show" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("Test Action")).toBeTruthy();
    expect(screen.queryByText("Should not show")).toBeNull();
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe("false");
  });

  it("draws the binding as key chips and exposes it on the option", () => {
    const { container } = render(
      <ActionPaletteItem
        item={makeItem({ keybinding: "⌘+K", shortcut: "Cmd+K" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    // The shared chord renderer, not the `+`-joined display string.
    expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
    expect(screen.queryByText("⌘+K")).toBeNull();
    // The visible chord sits in a presentational cluster, so the binding has
    // to reach assistive technology through the option itself.
    expect(screen.getByRole("option").getAttribute("aria-keyshortcuts")).toBeTruthy();
  });

  it("names the category only when asked to", () => {
    const { rerender } = render(
      <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
    );
    expect(screen.queryByText("terminal")).toBeTruthy();

    rerender(
      <ActionPaletteItem
        item={makeItem()}
        index={0}
        isSelected={false}
        onSelect={onSelect}
        showCategory={false}
      />
    );
    expect(screen.queryByText("terminal")).toBeNull();
  });

  it("marks the query's evidence in the title, and in the description only when the title has none", () => {
    const { container, rerender } = render(
      <ActionPaletteItem
        item={makeItem({ title: "Toggle sidebar", titleLower: "toggle sidebar" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
        highlightQuery="side"
      />
    );
    const marked = () =>
      Array.from(container.querySelectorAll("span"))
        .filter((el) => el.children.length === 0 && el.className.includes("bg-overlay-medium"))
        .map((el) => el.textContent);
    expect(marked()).toEqual(["side"]);

    rerender(
      <ActionPaletteItem
        item={makeItem({
          title: "Toggle sidebar",
          titleLower: "toggle sidebar",
          description: "Show or hide the navigator",
          descriptionLower: "show or hide the navigator",
        })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
        highlightQuery="navigator"
      />
    );
    expect(marked()).toEqual(["navigator"]);
  });

  it("renders a two-step chord as key glyphs rather than the display string", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ keybinding: "⌘+K ⌘+R", shortcut: "Cmd+K Cmd+R" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    const keys = Array.from(screen.getByRole("option").querySelectorAll("kbd"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.textContent === "+")).toBe(false);
    expect(screen.queryByText("⌘+K ⌘+R")).toBeNull();
  });

  it("applies selected styling with aria-selected", () => {
    render(<ActionPaletteItem item={makeItem()} index={0} isSelected={true} onSelect={onSelect} />);

    const row = screen.getByRole("option");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("does not branch styling on isSelected — selection is purely aria-driven", () => {
    const { rerender } = render(
      <ActionPaletteItem item={makeItem()} index={0} isSelected={true} onSelect={onSelect} />
    );
    const selectedClass = screen.getByRole("option").className;
    rerender(
      <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
    );
    const unselectedClass = screen.getByRole("option").className;
    // Class lists must be identical — only aria-selected attribute differs.
    expect(selectedClass).toBe(unselectedClass);
  });

  it("calls onHoverIndex with index when pointer moves over the item", () => {
    const onHoverIndex = vi.fn();
    render(
      <ActionPaletteItem
        item={makeItem()}
        index={3}
        isSelected={false}
        onSelect={onSelect}
        onHoverIndex={onHoverIndex}
      />
    );

    const row = screen.getByRole("option");
    fireEvent.pointerMove(row);
    expect(onHoverIndex).toHaveBeenCalledTimes(1);
    expect(onHoverIndex).toHaveBeenCalledWith(3);
  });

  it("does not throw when onHoverIndex is omitted", () => {
    render(
      <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
    );

    const row = screen.getByRole("option");
    expect(() => fireEvent.pointerMove(row)).not.toThrow();
  });

  it("calls onSelect when an enabled item's row body is clicked", () => {
    const item = makeItem({ enabled: true });
    render(<ActionPaletteItem item={item} index={0} isSelected={false} onSelect={onSelect} />);

    // The row body is the button labeled with the item's title (sibling of pin/hide buttons).
    const rowButton = screen.getByRole("option");
    fireEvent.click(rowButton);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it("keeps pin/hide buttons clickable on a disabled MRU row (not nested in disabled button)", () => {
    const item = makeItem({ enabled: false, disabledReason: "No focused terminal" });
    const onHide = vi.fn();
    const onPin = vi.fn(() => true);
    render(
      <ActionPaletteItem
        item={item}
        index={0}
        isSelected={false}
        onSelect={onSelect}
        onPin={onPin}
        onHide={onHide}
      />
    );

    const pinButton = screen.getByTestId("action-palette-pin");
    const hideButton = screen.getByTestId("action-palette-hide");
    fireEvent.click(pinButton);
    fireEvent.click(hideButton);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  describe("pin & hide affordances", () => {
    it("renders the pin button when onPin is provided", () => {
      render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onPin={() => true}
        />
      );

      expect(screen.getByTestId("action-palette-pin")).toBeTruthy();
    });

    it("renders the hide button when onHide is provided and the item is not pinned or destructive", () => {
      render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onHide={() => {}}
        />
      );

      expect(screen.getByTestId("action-palette-hide")).toBeTruthy();
    });

    it("hides the hide button on destructive (danger:'confirm') items", () => {
      render(
        <ActionPaletteItem
          item={makeItem({ danger: "confirm" })}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onHide={() => {}}
        />
      );

      expect(screen.queryByTestId("action-palette-hide")).toBeNull();
    });

    it("calls onPin and stops propagation when the pin button is clicked", () => {
      const onPin = vi.fn(() => true);
      render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onPin={onPin}
        />
      );

      onSelect.mockClear();
      const pinButton = screen.getByTestId("action-palette-pin");
      fireEvent.click(pinButton);

      expect(onPin).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("does not offer pin on a destructive row, since pinning one is always refused", () => {
      const onPin = vi.fn(() => false);
      render(
        <ActionPaletteItem
          item={makeItem({ danger: "confirm" })}
          index={0}
          isSelected
          onSelect={onSelect}
          onPin={onPin}
        />
      );

      expect(screen.queryByTestId("action-palette-pin")).toBeNull();
    });

    it("names the keyboard chord on both controls, since nothing else teaches it", () => {
      render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected
          onSelect={onSelect}
          onPin={() => true}
          onHide={() => {}}
        />
      );

      // Derived from the same constants the handler matches on, so a chord
      // change can't leave the tooltip advertising the old one.
      for (const [testId, shortcut] of [
        ["action-palette-pin", PIN_SHORTCUT],
        ["action-palette-hide", HIDE_SHORTCUT],
      ] as const) {
        const control = screen.getByTestId(testId);
        expect(control.hasAttribute("title")).toBe(false);
        const tip = control.nextElementSibling;
        expect(tip?.getAttribute("data-testid")).toBe("tooltip-content");
        const keycaps = render(<KbdChord shortcut={shortcut} />).container.textContent;
        expect(tip?.textContent).toContain(keycaps);
      }
    });

    it("uses 'Unpin' label and routes click to onUnpin when isPinned", () => {
      const onUnpin = vi.fn();
      const item = makeItem();
      render(
        <ActionPaletteItem
          item={item}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onPin={() => true}
          onUnpin={onUnpin}
          isPinned
        />
      );

      const unpinButton = screen.getByTestId("action-palette-pin");
      fireEvent.click(unpinButton);

      expect(onUnpin).toHaveBeenCalledTimes(1);
      expect(onUnpin).toHaveBeenCalledWith(item.id);
    });

    it("hides the hide button when the item is already pinned", () => {
      render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onPin={() => true}
          onUnpin={() => {}}
          onHide={() => {}}
          isPinned
        />
      );

      expect(screen.queryByTestId("action-palette-hide")).toBeNull();
    });
  });

  describe("confirm-tier rows", () => {
    function confirmItem(overrides: Partial<ActionPaletteItemType> = {}): ActionPaletteItemType {
      return makeItem({
        id: "worktree-delete",
        title: "Delete worktree",
        danger: "confirm",
        dangerRationale: "Removes the working tree and branch from disk",
        ...overrides,
      });
    }

    it("appends a HIG ellipsis suffix on confirm-tier titles", () => {
      render(
        <ActionPaletteItem item={confirmItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(screen.getByText("Delete worktree…")).toBeTruthy();
      expect(screen.queryByText("Delete worktree")).toBeNull();
    });

    it("never doubles the ellipsis on a title that already carries one", () => {
      render(
        <ActionPaletteItem
          item={confirmItem({ title: "Import configuration…" })}
          index={0}
          isSelected={false}
          onSelect={onSelect}
        />
      );

      const title = screen.getByRole("option").textContent ?? "";
      expect(title.match(/…/g)?.length).toBe(1);
    });

    it("does not append the ellipsis on safe-tier titles", () => {
      render(
        <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(screen.getByText("Test Action")).toBeTruthy();
      expect(screen.queryByText(/…/)).toBeNull();
    });

    it('sets aria-haspopup="dialog" on confirm-tier rows', () => {
      const { container } = render(
        <ActionPaletteItem item={confirmItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(container.querySelector('[role="option"]')?.getAttribute("aria-haspopup")).toBe(
        "dialog"
      );
    });

    it("does not set aria-haspopup on safe-tier rows", () => {
      const { container } = render(
        <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(container.querySelector('[role="option"]')?.getAttribute("aria-haspopup")).toBeNull();
    });

    it("renders a TriangleAlert icon on confirm-tier rows", () => {
      const { container } = render(
        <ActionPaletteItem item={confirmItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      const icon = container.querySelector('svg[aria-hidden="true"]');
      expect(icon).toBeTruthy();
    });

    it("does not render the alert icon on safe-tier rows", () => {
      const { container } = render(
        <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(container.querySelector('svg[aria-hidden="true"]')).toBeNull();
    });

    it("describes a confirm-tier row by its consequence first, selected or not", () => {
      for (const isSelected of [true, false]) {
        const { container, unmount } = render(
          <ActionPaletteItem
            item={confirmItem()}
            index={0}
            isSelected={isSelected}
            onSelect={onSelect}
          />
        );
        const option = container.querySelector<HTMLElement>('[role="option"]')!;
        // A row that showed its consequence only under the cursor grew as the
        // cursor landed on it, so the line and its reference are unconditional.
        expect(describedTexts(option)[0]).toBe("Removes the working tree and branch from disk");
        expect(labelText(option)).toBe("Delete worktree…");
        unmount();
      }
    });

    it("omits the rationale node and reference when dangerRationale is missing", () => {
      const item = confirmItem({ dangerRationale: undefined });
      const { container } = render(
        <ActionPaletteItem item={item} index={0} isSelected={true} onSelect={onSelect} />
      );

      const option = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(describedIds(option).some((id) => id.endsWith("danger-rationale"))).toBe(false);
      expect(container.querySelector('[id$="-danger-rationale"]')).toBeNull();
      // Suffix and icon still render — they gate on `danger === "confirm"`, not on rationale.
      expect(screen.getByText("Delete worktree…")).toBeTruthy();
      expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    });
  });

  describe("accessible name and description", () => {
    it("names the option by its title alone", () => {
      const { container } = render(
        <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
      );
      const option = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(labelText(option)).toBe("Test Action");
    });

    it("describes the row by its category, summary and the footer hint, in that order", () => {
      const { container } = render(
        <>
          <ActionPaletteItem
            item={makeItem()}
            index={0}
            isSelected={false}
            onSelect={onSelect}
            footerHintId="palette-footer-hint"
          />
          <div id="palette-footer-hint">↵ to run</div>
        </>
      );
      const option = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(describedTexts(option)).toEqual(["terminal", "Test description", "↵ to run"]);
    });

    it("puts an unavailable row's reason ahead of everything else it says", () => {
      const { container } = render(
        <ActionPaletteItem
          item={makeItem({ enabled: false, disabledReason: "No focused terminal" })}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          footerHintId="palette-footer-hint"
        />
      );
      const option = container.querySelector<HTMLElement>('[role="option"]')!;
      expect(describedTexts(option)[0]).toBe("No focused terminal");
    });

    it("references the rationale before the footer hint on a confirm-tier row", () => {
      const item = {
        ...makeItem(),
        id: "delete-worktree",
        danger: "confirm" as const,
        dangerRationale: "Removes the working tree",
      };
      const { container } = render(
        <>
          <ActionPaletteItem
            item={item}
            index={0}
            isSelected={true}
            onSelect={onSelect}
            footerHintId="palette-footer-hint"
          />
          <div id="palette-footer-hint">↵ to delete</div>
        </>
      );
      const texts = describedTexts(container.querySelector<HTMLElement>('[role="option"]')!);
      expect(texts.indexOf("Removes the working tree")).toBeLessThan(texts.indexOf("↵ to delete"));
    });

    it("omits aria-describedby entirely when the row has nothing to describe it", () => {
      const { container } = render(
        <ActionPaletteItem
          item={makeItem({ description: "", descriptionLower: "" })}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          showCategory={false}
        />
      );
      expect(
        container.querySelector('[role="option"]')?.getAttribute("aria-describedby")
      ).toBeNull();
    });
  });
});

describe("paletteSummary", () => {
  it("shows one sentence, never the implementation note after it", () => {
    const summary = paletteSummary(
      "Alias for generating a worktree context bundle. It accepts a subset of the copy-tree capabilities."
    );
    expect(summary).toBe("Alias for generating a worktree context bundle");
    expect(summary).not.toMatch(/[.!?]\s/);
  });

  it("doesn't split on an abbreviation", () => {
    expect(paletteSummary("Pick a runtime, e.g. Node. Then run")).toContain("e.g. Node");
  });

  it("leaves a single clause as it is, minus a trailing period", () => {
    expect(paletteSummary("Toggle sidebar visibility")).toBe("Toggle sidebar visibility");
    expect(paletteSummary("Reset the width.")).toBe("Reset the width");
  });
});
