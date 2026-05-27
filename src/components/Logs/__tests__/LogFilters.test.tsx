// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { LogFilters } from "../LogFilters";
import { dispatchEscape, _resetForTests } from "@/lib/escapeStack";

describe("LogFilters accessibility", () => {
  afterEach(() => {
    _resetForTests();
  });

  const baseProps = {
    filters: {} as {
      levels?: import("@/types").LogLevel[];
      sources?: string[];
      search?: string;
    },
    onFiltersChange: vi.fn(),
    onClear: vi.fn(),
    availableSources: ["renderer", "main", "preload"],
    levelCounts: { debug: 1, info: 2, warn: 3, error: 4 } as const,
    sourceCounts: { renderer: 3, main: 1, preload: 0 } as Partial<Record<string, number>>,
  };

  it("renders search input with type='search'", () => {
    render(<LogFilters {...baseProps} />);
    const input = screen.getByPlaceholderText("Search logs...") as HTMLInputElement;
    expect(input.type).toBe("search");
  });

  it("renders active and inactive level pills with aria-pressed", () => {
    render(<LogFilters {...baseProps} filters={{ levels: ["info", "error"] }} />);
    const debugBtn = screen.getByLabelText("Debug (1)");
    const infoBtn = screen.getByLabelText("Info (2)");
    expect(debugBtn.getAttribute("aria-pressed")).toBe("false");
    expect(infoBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders sources trigger with aria-haspopup", () => {
    render(<LogFilters {...baseProps} />);
    const trigger = screen.getByText(/Sources/).closest("button")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles aria-expanded when sources popover opens and closes", async () => {
    render(<LogFilters {...baseProps} />);
    const trigger = screen.getByText(/Sources/).closest("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    dispatchEscape();
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("renders source items with aria-pressed when popover is open", () => {
    render(<LogFilters {...baseProps} filters={{ sources: ["renderer"] }} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    const rendererBtn = screen.getByText(/\* renderer/).closest("button")!;
    const mainBtn = screen.getByText("main").closest("button")!;
    expect(rendererBtn.getAttribute("aria-pressed")).toBe("true");
    expect(mainBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("closes sources popover on Escape", async () => {
    render(<LogFilters {...baseProps} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    expect(screen.getByText(/renderer/)).toBeTruthy();
    dispatchEscape();
    await waitFor(() => {
      expect(screen.queryByText(/renderer/)).toBeNull();
    });
  });

  it("syncs the local search input when filters.search is cleared externally", async () => {
    const onFiltersChange = vi.fn();
    const { rerender } = render(
      <LogFilters {...baseProps} filters={{ search: "foo" }} onFiltersChange={onFiltersChange} />
    );
    const input = screen.getByPlaceholderText("Search logs...") as HTMLInputElement;
    expect(input.value).toBe("foo");

    rerender(<LogFilters {...baseProps} filters={{}} onFiltersChange={onFiltersChange} />);

    await waitFor(() => {
      expect(input.value).toBe("");
    });

    onFiltersChange.mockClear();
    await new Promise((r) => setTimeout(r, 250));
    expect(onFiltersChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: "foo" })
    );
  });

  it("renders source counts beside source names in dropdown", () => {
    render(<LogFilters {...baseProps} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    const rendererBtn = screen.getByText(/^\*?renderer/).closest("button")!;
    const mainBtn = screen.getByText(/^\*?main/).closest("button")!;
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    expect(rendererBtn.textContent).toContain("3");
    expect(mainBtn.textContent).toContain("1");
    expect(preloadBtn.textContent).toContain("0");
  });

  it("dims zero-count source rows with opacity-50", () => {
    render(<LogFilters {...baseProps} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    expect(preloadBtn.className).toContain("opacity-50");
  });

  it("keeps zero-count source rows clickable", () => {
    const onFiltersChange = vi.fn();
    render(<LogFilters {...baseProps} onFiltersChange={onFiltersChange} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    fireEvent.click(preloadBtn);
    expect(onFiltersChange).toHaveBeenCalledWith({ sources: ["preload"] });
  });

  it("right-aligns count with ml-auto and uses tabular-nums", () => {
    render(<LogFilters {...baseProps} />);
    fireEvent.click(screen.getByText(/Sources/).closest("button")!);
    const rendererBtn = screen.getByText(/^\*?renderer/).closest("button")!;
    const countSpan = rendererBtn.querySelector("span.ml-auto.tabular-nums");
    expect(countSpan).toBeTruthy();
    expect(countSpan!.className).toContain("opacity-70");
  });
});
