// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ThemeSelector } from "../ThemeSelector";

interface TestItem {
  id: string;
  name: string;
}

const items: TestItem[] = [
  { id: "alpha", name: "Alpha Theme" },
  { id: "beta", name: "Beta Theme" },
  { id: "gamma", name: "Gamma Theme" },
];

const defaultProps = {
  items,
  selectedId: "alpha",
  onSelect: vi.fn(),
  renderPreview: (item: TestItem) => <div data-testid={`preview-${item.id}`}>Preview</div>,
  getName: (item: TestItem) => item.name,
};

describe("ThemeSelector", () => {
  it("calls onSelect with id and click origin when item is clicked", () => {
    const onSelect = vi.fn();
    render(<ThemeSelector {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Gamma Theme"), { clientX: 123, clientY: 456 });
    expect(onSelect).toHaveBeenCalledWith("gamma", { x: 123, y: 456 });
  });

  it("filters items by search query (case-insensitive)", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "beta" } });

    expect(screen.queryByText("Alpha Theme")).toBeNull();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.queryByText("Gamma Theme")).toBeNull();
  });

  it("shows empty state when no items match search", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    // Shown in place of the list, and repeated in the live region so it is heard too.
    expect(screen.getAllByText("No themes match your search").length).toBeGreaterThan(0);
  });

  it("clears search on Escape key", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.queryByText("Alpha Theme")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders group labels when groups are provided", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        items={undefined}
        groups={[
          { label: "Dark", items: [items[0]!, items[1]!] },
          { label: "Light", items: [items[2]!] },
        ]}
      />
    );
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("filters within groups", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        items={undefined}
        groups={[
          { label: "Dark", items: [items[0]!, items[1]!] },
          { label: "Light", items: [items[2]!] },
        ]}
      />
    );
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "gamma" } });

    expect(screen.queryByText("Dark")).toBeNull();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders search input with correct aria-label", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByLabelText("Filter themes")).toBeTruthy();
  });
});

describe("ThemeSelector preview interactions", () => {
  let pendingRaf: Array<{ handle: number; cb: FrameRequestCallback }> = [];
  let nextHandle = 0;

  const rafSpy = vi.fn((cb: FrameRequestCallback) => {
    nextHandle += 1;
    pendingRaf.push({ handle: nextHandle, cb });
    return nextHandle;
  });
  const cafSpy = vi.fn((handle: number) => {
    pendingRaf = pendingRaf.filter((entry) => entry.handle !== handle);
  });

  const flushRaf = () => {
    act(() => {
      const pending = pendingRaf;
      pendingRaf = [];
      for (const entry of pending) entry.cb(0);
    });
  };

  beforeEach(() => {
    pendingRaf = [];
    nextHandle = 0;
    rafSpy.mockClear();
    cafSpy.mockClear();
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    vi.stubGlobal("cancelAnimationFrame", cafSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("calls onPreviewItem on pointer enter with the item id", () => {
    const onPreviewItem = vi.fn();
    render(<ThemeSelector {...defaultProps} onPreviewItem={onPreviewItem} />);

    const card = screen.getAllByRole("option").find((o) => o.textContent?.includes("Beta Theme"))!;
    fireEvent.pointerEnter(card);

    expect(onPreviewItem).toHaveBeenCalledWith("beta");
  });

  it("schedules onPreviewEnd via rAF on pointer leave", () => {
    const onPreviewItem = vi.fn();
    const onPreviewEnd = vi.fn();
    render(
      <ThemeSelector {...defaultProps} onPreviewItem={onPreviewItem} onPreviewEnd={onPreviewEnd} />
    );

    const card = screen.getAllByRole("option").find((o) => o.textContent?.includes("Beta Theme"))!;
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);

    expect(onPreviewEnd).not.toHaveBeenCalled();
    expect(rafSpy).toHaveBeenCalledTimes(1);

    flushRaf();

    expect(onPreviewEnd).toHaveBeenCalledTimes(1);
  });

  it("cancels pending revert when another card receives pointer enter", () => {
    const onPreviewItem = vi.fn();
    const onPreviewEnd = vi.fn();
    render(
      <ThemeSelector {...defaultProps} onPreviewItem={onPreviewItem} onPreviewEnd={onPreviewEnd} />
    );

    const options = screen.getAllByRole("option");
    const cardBeta = options.find((o) => o.textContent?.includes("Beta Theme"))!;
    const cardGamma = options.find((o) => o.textContent?.includes("Gamma Theme"))!;

    fireEvent.pointerEnter(cardBeta);
    fireEvent.pointerLeave(cardBeta);
    fireEvent.pointerEnter(cardGamma);

    flushRaf();

    expect(onPreviewEnd).not.toHaveBeenCalled();
    expect(onPreviewItem).toHaveBeenNthCalledWith(1, "beta");
    expect(onPreviewItem).toHaveBeenNthCalledWith(2, "gamma");
    expect(cafSpy).toHaveBeenCalled();
  });

  it("mirrors pointer events on focus/blur for keyboard parity", () => {
    const onPreviewItem = vi.fn();
    const onPreviewEnd = vi.fn();
    render(
      <ThemeSelector {...defaultProps} onPreviewItem={onPreviewItem} onPreviewEnd={onPreviewEnd} />
    );

    const card = screen.getAllByRole("option").find((o) => o.textContent?.includes("Gamma Theme"))!;
    fireEvent.focus(card);
    expect(onPreviewItem).toHaveBeenCalledWith("gamma");

    fireEvent.blur(card);
    flushRaf();
    expect(onPreviewEnd).toHaveBeenCalledTimes(1);
  });

  it("renders previewAnnouncement inside a polite aria-live region", () => {
    const { container } = render(
      <ThemeSelector {...defaultProps} previewAnnouncement="Previewing: Beta Theme" />
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).toBe("Previewing: Beta Theme");
  });

  it("mounts the aria-live region even without a preview announcement", () => {
    const { container } = render(<ThemeSelector {...defaultProps} />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe("");
  });

  it("cancels pending rAF on unmount", () => {
    const onPreviewItem = vi.fn();
    const onPreviewEnd = vi.fn();
    const { unmount } = render(
      <ThemeSelector {...defaultProps} onPreviewItem={onPreviewItem} onPreviewEnd={onPreviewEnd} />
    );

    const card = screen.getAllByRole("option").find((o) => o.textContent?.includes("Beta Theme"))!;
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);

    expect(pendingRaf.length).toBe(1);

    unmount();

    expect(cafSpy).toHaveBeenCalled();
  });

  it("is a no-op when no preview callbacks are provided", () => {
    render(<ThemeSelector {...defaultProps} />);
    const card = screen.getAllByRole("option").find((o) => o.textContent?.includes("Beta Theme"))!;
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    expect(rafSpy).not.toHaveBeenCalled();
  });
});

interface KeyboardItem {
  id: string;
  name: string;
}

describe("ThemeSelector keyboard contract", () => {
  const items: KeyboardItem[] = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
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
