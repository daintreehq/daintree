// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ThemeSelector } from "../ThemeSelector";

interface Item {
  id: string;
  name: string;
}

const items: Item[] = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
  id,
  name: `Scheme ${id.toUpperCase()}`,
}));

function renderSelector(selectedId = "c", onSelect = vi.fn(), columns: 2 | 3 = 3) {
  const view = render(
    <ThemeSelector
      items={items}
      selectedId={selectedId}
      onSelect={onSelect}
      columns={columns}
      getName={(i) => i.name}
      renderPreview={(i) => <pre>{`$ ls ${i.id}`}</pre>}
    />
  );
  return { ...view, onSelect };
}

const options = () => screen.getAllByRole("option");
const tabStops = () => options().filter((o) => o.tabIndex === 0);

afterEach(cleanup);

describe("ThemeSelector keyboard contract", () => {
  it("is exactly one tab stop, on the selection", () => {
    renderSelector("c");
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("falls back to one tab stop on the first option when the selection is filtered out", () => {
    renderSelector("zzz");
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(options()[0]);
  });

  it("names each option by its label alone, not by the sample inside it", () => {
    renderSelector();
    for (const option of options()) {
      expect(option.getAttribute("aria-label")).toMatch(/^Scheme [A-G]$/);
      expect(option.querySelector("pre")!.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it("moves and selects together, stepping by a row for up and down", () => {
    const { onSelect } = renderSelector("c", vi.fn(), 3);
    const listbox = screen.getByRole("listbox");
    options()[2]!.focus();

    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("d");
    expect(document.activeElement).toBe(options()[3]);

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("g");
    expect(document.activeElement).toBe(options()[6]);

    fireEvent.keyDown(listbox, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("a");

    fireEvent.keyDown(listbox, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("g");
  });

  it("moves straight down or not at all from the last row", () => {
    // 7 options in 3 columns: e (index 4) sits above nothing, so Down must not slide to g.
    const { onSelect } = renderSelector("e", vi.fn(), 3);
    const listbox = screen.getByRole("listbox");
    options()[4]!.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options()[4]);
  });

  it("stays on the grid's edges instead of wrapping", () => {
    const { onSelect } = renderSelector("a");
    const listbox = screen.getByRole("listbox");
    options()[0]!.focus();
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    fireEvent.keyDown(listbox, { key: "ArrowLeft" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options()[0]);
  });
});
