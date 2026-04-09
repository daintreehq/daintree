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
  it("renders all items", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders preview for each item", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByTestId("preview-alpha")).toBeTruthy();
    expect(screen.getByTestId("preview-beta")).toBeTruthy();
    expect(screen.getByTestId("preview-gamma")).toBeTruthy();
  });

  it("marks selected item with aria-selected", () => {
    render(<ThemeSelector {...defaultProps} selectedId="beta" />);
    const options = screen.getAllByRole("option");
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toBeTruthy();
    expect(selected!.textContent).toContain("Beta Theme");
  });

  it("calls onSelect with id and click origin when item is clicked", () => {
    const onSelect = vi.fn();
    render(<ThemeSelector {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Gamma Theme"), { clientX: 123, clientY: 456 });
    expect(onSelect).toHaveBeenCalledWith("gamma", { x: 123, y: 456 });
  });

  it("filters items by search query (case-insensitive)", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "beta" } });

    expect(screen.queryByText("Alpha Theme")).toBeNull();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.queryByText("Gamma Theme")).toBeNull();
  });

  it("shows empty state when no items match search", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText("No themes match your search.")).toBeTruthy();
  });

  it("clears search on Escape key", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
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
          { label: "Dark", items: [items[0], items[1]] },
          { label: "Light", items: [items[2]] },
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
          { label: "Dark", items: [items[0], items[1]] },
          { label: "Light", items: [items[2]] },
        ]}
      />
    );
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "gamma" } });

    expect(screen.queryByText("Dark")).toBeNull();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("uses renderMeta when provided", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        renderMeta={(item) => <span data-testid={`meta-${item.id}`}>{item.name} (custom)</span>}
      />
    );
    expect(screen.getByTestId("meta-alpha")).toBeTruthy();
    expect(screen.getByText("Alpha Theme (custom)")).toBeTruthy();
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
