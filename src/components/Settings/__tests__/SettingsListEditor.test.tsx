// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsListGroup, SettingsListRow } from "../SettingsListEditor";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";

function Harness({ initial, row = false }: { initial: string[]; row?: boolean }) {
  const [items, setItems] = useState(initial);
  const common = {
    items,
    onChange: setItems,
    placeholder: "glob",
    itemNoun: "Pattern",
    addLabel: "Add pattern",
    reorderable: true,
  };
  return (
    <SettingsGroup>
      {row ? (
        <SettingsListRow label="Patterns" description="Globs" {...common} />
      ) : (
        <SettingsListGroup emptyText="Nothing yet" {...common} />
      )}
    </SettingsGroup>
  );
}

const fields = () => screen.queryAllByRole<HTMLInputElement>("textbox");

describe("SettingsListEditor focus recovery", () => {
  it.each([false, true])("puts the caret in a new item after Add (row=%s)", async (row) => {
    render(<Harness initial={["a"]} row={row} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    });
    expect(fields()).toHaveLength(2);
    expect(document.activeElement).toBe(fields()[1]);
  });

  it.each([false, true])("focuses the first item added to an empty list (row=%s)", async (row) => {
    render(<Harness initial={[]} row={row} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    });
    expect(fields()).toHaveLength(1);
    expect(document.activeElement).toBe(fields()[0]);
  });

  it("moves focus to the item that took a deleted item's place", async () => {
    render(<Harness initial={["a", "b", "c"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Pattern a" }));
    });
    expect(fields().map((f) => f.value)).toEqual(["b", "c"]);
    expect(document.activeElement).toBe(fields()[0]);
  });

  it("falls back to the previous item when the last one is deleted", async () => {
    render(<Harness initial={["a", "b"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Pattern b" }));
    });
    expect(document.activeElement).toBe(fields()[0]);
  });

  it("never leaves focus on the document body", async () => {
    render(<Harness initial={["only"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Pattern only" }));
    });
    expect(fields()).toHaveLength(0);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("SettingsListEditor actions", () => {
  it("gives every item's actions a name unique to that item", () => {
    render(<Harness initial={["x/**", "y/**", "z/**"]} />);
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((n): n is string => !!n);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reorders without losing an item", async () => {
    render(<Harness initial={["a", "b", "c"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Pattern c up" }));
    });
    expect(
      fields()
        .map((f) => f.value)
        .sort()
    ).toEqual(["a", "b", "c"]);
    expect(fields().map((f) => f.value)).toEqual(["a", "c", "b"]);
  });
});

describe("SettingsListEditor keyboard reordering", () => {
  afterEach(() => _resetTooltipFocusSuppressionForTests());

  const values = () => fields().map((f) => f.value);
  // A keyboard Enter or Space on a focused button is a click with no pointer behind it.
  const press = async (button: HTMLElement) => {
    act(() => button.focus());
    await act(async () => {
      fireEvent.click(button);
    });
  };
  const pressNamed = (name: string) => press(screen.getByRole("button", { name }));
  const focusedButton = () => document.activeElement as HTMLButtonElement;

  it.each([false, true])(
    "keeps focus on the item it moved into the first position (row=%s)",
    async (row) => {
      render(<Harness initial={["a", "b", "c"]} row={row} />);
      await pressNamed("Move Pattern b up");
      expect(values()).toEqual(["b", "a", "c"]);
      expect(focusedButton().getAttribute("aria-label")).toBe("Move Pattern b up");
      // Unavailable at the top, but still focusable: a natively disabled button
      // would make Chromium throw focus onto the body.
      expect(focusedButton().disabled).toBe(false);
      expect(focusedButton().getAttribute("aria-disabled")).toBe("true");
    }
  );

  it.each([false, true])(
    "keeps focus on the item it moved into the last position (row=%s)",
    async (row) => {
      render(<Harness initial={["a", "b", "c"]} row={row} />);
      await pressNamed("Move Pattern b down");
      expect(values()).toEqual(["a", "c", "b"]);
      expect(focusedButton().getAttribute("aria-label")).toBe("Move Pattern b down");
      expect(focusedButton().disabled).toBe(false);
      expect(focusedButton().getAttribute("aria-disabled")).toBe("true");
    }
  );

  it("follows the moved item rather than the position it left", async () => {
    render(<Harness initial={["a", "b", "c", "d"]} />);
    await pressNamed("Move Pattern c up");
    expect(values()).toEqual(["a", "c", "b", "d"]);
    expect(focusedButton().getAttribute("aria-label")).toBe("Move Pattern c up");
    expect(focusedButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("does nothing when the arrow is pressed again at the boundary", async () => {
    render(<Harness initial={["a", "b", "c"]} />);
    await pressNamed("Move Pattern c up");
    await press(focusedButton());
    expect(values()).toEqual(["c", "a", "b"]);
    await press(focusedButton());
    expect(values()).toEqual(["c", "a", "b"]);
    expect(focusedButton().getAttribute("aria-label")).toBe("Move Pattern c up");
  });

  it.each([
    ["Move Pattern b up", "Move up"],
    ["Move Pattern b down", "Move down"],
    ["Remove Pattern b", "Remove"],
    ["Move Pattern a up", "Move up"],
  ])("names the %s icon button in a tooltip", async (name, tooltip) => {
    render(<Harness initial={["a", "b", "c"]} />);
    act(() => screen.getByRole("button", { name }).focus());
    const tip = await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 });
    expect(tip.textContent).toBe(tooltip);
  });

  it("does not open the tooltip of the arrow focus follows the moved item to", async () => {
    render(<Harness initial={["a", "b", "c"]} />);
    const pressed = screen.getByRole("button", { name: "Move Pattern b up" });
    // A pointer press: the row moves out from under the pointer, and focus follows it.
    await act(async () => {
      fireEvent.click(pressed, { detail: 1 });
    });
    expect(focusedButton().getAttribute("aria-label")).toBe("Move Pattern b up");
    expect(focusedButton()).not.toBe(pressed);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });
});
