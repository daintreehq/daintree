// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsListGroup, SettingsListRow } from "../SettingsListEditor";

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
      fireEvent.click(screen.getByRole("button", { name: "Delete Pattern a" }));
    });
    expect(fields().map((f) => f.value)).toEqual(["b", "c"]);
    expect(document.activeElement).toBe(fields()[0]);
  });

  it("falls back to the previous item when the last one is deleted", async () => {
    render(<Harness initial={["a", "b"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Pattern b" }));
    });
    expect(document.activeElement).toBe(fields()[0]);
  });

  it("never leaves focus on the document body", async () => {
    render(<Harness initial={["only"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete Pattern only" }));
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
