// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionPaletteItem } from "./ActionPaletteItem";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/config/categoryColors", () => ({
  ACTION_CATEGORY_COLORS: {
    terminal: "bg-category-blue-subtle text-category-blue-text border border-category-blue-border",
  },
  ACTION_CATEGORY_DEFAULT_COLOR: "bg-tint/[0.06] text-daintree-text/50",
}));

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

  it("renders keybinding when present", () => {
    render(
      <ActionPaletteItem
        item={makeItem({ keybinding: "⌘K" })}
        index={0}
        isSelected={false}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("⌘K")).toBeTruthy();
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

    it("surfaces a rejection message when onPin returns false (e.g., destructive action)", () => {
      const onPin = vi.fn(() => false);
      render(
        <ActionPaletteItem
          item={makeItem({ danger: "confirm" })}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          onPin={onPin}
        />
      );

      const pinButton = screen.getByTestId("action-palette-pin");
      fireEvent.click(pinButton);

      expect(onPin).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Can't pin destructive actions")).toBeTruthy();
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

      expect(screen.getByText("Delete worktree …")).toBeTruthy();
      expect(screen.queryByText("Delete worktree")).toBeNull();
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

    it("links selected confirm-tier rows to their rationale via aria-describedby", () => {
      const item = confirmItem();
      const { container } = render(
        <ActionPaletteItem item={item} index={0} isSelected={true} onSelect={onSelect} />
      );

      const button = container.querySelector('[role="option"]');
      const expectedId = `${item.id}-danger-rationale`;
      expect(button?.getAttribute("aria-describedby")).toBe(expectedId);

      const rationale = container.querySelector(`#${expectedId}`);
      expect(rationale).toBeTruthy();
      expect(rationale?.textContent).toBe("Removes the working tree and branch from disk");
    });

    it("omits aria-describedby on unselected confirm-tier rows", () => {
      const item = confirmItem();
      const { container } = render(
        <ActionPaletteItem item={item} index={0} isSelected={false} onSelect={onSelect} />
      );

      expect(
        container.querySelector('[role="option"]')?.getAttribute("aria-describedby")
      ).toBeNull();
      // Rationale node still in DOM (CSS-hidden) so the id target is stable across renders.
      expect(container.querySelector(`#${item.id}-danger-rationale`)).toBeTruthy();
    });

    it("omits rationale node and aria-describedby when dangerRationale is missing", () => {
      const item = confirmItem({ dangerRationale: undefined });
      const { container } = render(
        <ActionPaletteItem item={item} index={0} isSelected={true} onSelect={onSelect} />
      );

      const button = container.querySelector('[role="option"]');
      expect(button?.getAttribute("aria-describedby")).toBeNull();
      expect(container.querySelector(`#${item.id}-danger-rationale`)).toBeNull();
      // Suffix and icon still render — they gate on `danger === "confirm"`, not on rationale.
      expect(screen.getByText("Delete worktree …")).toBeTruthy();
      expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    });
  });

  describe("footerHintId aria-describedby", () => {
    it("points aria-describedby at the supplied footerHintId", () => {
      const { container } = render(
        <ActionPaletteItem
          item={makeItem()}
          index={0}
          isSelected={false}
          onSelect={onSelect}
          footerHintId="palette-footer-hint"
        />
      );
      expect(container.querySelector('[role="option"]')?.getAttribute("aria-describedby")).toBe(
        "palette-footer-hint"
      );
    });

    it("appends the rationale id when selected on a confirm-tier row", () => {
      const item = {
        ...makeItem(),
        id: "delete-worktree",
        danger: "confirm" as const,
        dangerRationale: "Removes the working tree",
      };
      const { container } = render(
        <ActionPaletteItem
          item={item}
          index={0}
          isSelected={true}
          onSelect={onSelect}
          footerHintId="palette-footer-hint"
        />
      );
      expect(container.querySelector('[role="option"]')?.getAttribute("aria-describedby")).toBe(
        "palette-footer-hint delete-worktree-danger-rationale"
      );
    });

    it("omits aria-describedby entirely when no footerHintId and no selected rationale", () => {
      const { container } = render(
        <ActionPaletteItem item={makeItem()} index={0} isSelected={false} onSelect={onSelect} />
      );
      expect(
        container.querySelector('[role="option"]')?.getAttribute("aria-describedby")
      ).toBeNull();
    });
  });
});
