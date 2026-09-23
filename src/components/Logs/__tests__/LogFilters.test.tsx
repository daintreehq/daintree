// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { LogFilters } from "../LogFilters";
import { _resetForTests } from "@/lib/escapeStack";

async function openSources() {
  const trigger = screen.getByText(/Sources/).closest("button")!;
  fireEvent.click(trigger);
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}

function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

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
    const input = screen.getByRole("searchbox", { name: "Search logs" }) as HTMLInputElement;
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
    expect(screen.getByText(/Sources/).closest("button")!.getAttribute("aria-expanded")).not.toBe(
      "true"
    );
    const trigger = await openSources();
    pressEscape();
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("renders source items with aria-pressed when popover is open", async () => {
    render(<LogFilters {...baseProps} filters={{ sources: ["renderer"] }} />);
    await openSources();
    const rendererBtn = screen.getByText(/renderer/).closest("button")!;
    const mainBtn = screen.getByText("main").closest("button")!;
    expect(rendererBtn.getAttribute("aria-pressed")).toBe("true");
    expect(mainBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("closes sources popover on Escape", async () => {
    render(<LogFilters {...baseProps} />);
    await openSources();
    expect(screen.getByText(/renderer/)).toBeTruthy();
    pressEscape();
    await waitFor(() => {
      expect(screen.queryByText(/renderer/)).toBeNull();
    });
  });

  it("keeps what is typed into an empty search and commits it after the debounce", async () => {
    const onFiltersChange = vi.fn();
    render(<LogFilters {...baseProps} filters={{}} onFiltersChange={onFiltersChange} />);
    const input = screen.getByRole("searchbox", { name: "Search logs" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "g" } });
    expect(input.value).toBe("g");

    await waitFor(() => {
      expect(onFiltersChange).toHaveBeenCalledWith({ search: "g" });
    });
    expect(input.value).toBe("g");
  });

  it("syncs the local search input when filters.search is cleared externally", async () => {
    const onFiltersChange = vi.fn();
    const { rerender } = render(
      <LogFilters {...baseProps} filters={{ search: "foo" }} onFiltersChange={onFiltersChange} />
    );
    const input = screen.getByRole("searchbox", { name: "Search logs" }) as HTMLInputElement;
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

  it("renders source counts beside source names in dropdown", async () => {
    render(<LogFilters {...baseProps} />);
    await openSources();
    const rendererBtn = screen.getByText(/^\*?renderer/).closest("button")!;
    const mainBtn = screen.getByText(/^\*?main/).closest("button")!;
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    const rendererCount = rendererBtn.querySelector("span.ml-auto.tabular-nums");
    const mainCount = mainBtn.querySelector("span.ml-auto.tabular-nums");
    const preloadCount = preloadBtn.querySelector("span.ml-auto.tabular-nums");
    expect(rendererCount?.textContent).toBe("3");
    expect(mainCount?.textContent).toBe("1");
    expect(preloadCount?.textContent).toBe("0");
  });

  it("marks zero-count source rows as empty without fading them", async () => {
    // Opacity dimmed the row's focus ring and hover with it.
    render(<LogFilters {...baseProps} />);
    await openSources();
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    expect(preloadBtn.classList.contains("text-text-secondary")).toBe(true);
    expect(preloadBtn.dataset.empty).toBe("true");
    // Base-state opacity only; the Button's own `disabled:opacity-*` is fine.
    expect(preloadBtn.className.split(/\s+/)).not.toContainEqual(
      expect.stringMatching(/^opacity-/)
    );
  });

  it("keeps zero-count source rows clickable", async () => {
    const onFiltersChange = vi.fn();
    render(<LogFilters {...baseProps} onFiltersChange={onFiltersChange} />);
    await openSources();
    const preloadBtn = screen.getByText(/^\*?preload/).closest("button")!;
    fireEvent.click(preloadBtn);
    expect(onFiltersChange).toHaveBeenCalledWith({ sources: ["preload"] });
  });

  it("does not dim zero-count rows when the source is actively selected", async () => {
    render(
      <LogFilters
        {...baseProps}
        filters={{ sources: ["preload"] }}
        sourceCounts={{ ...baseProps.sourceCounts, preload: 0 }}
      />
    );
    await openSources();
    const preloadBtn = screen.getByText(/preload/).closest("button")!;
    expect(preloadBtn.getAttribute("aria-pressed")).toBe("true");
    expect(preloadBtn.classList.contains("text-text-secondary")).toBe(false);
    expect(preloadBtn.dataset.empty).toBeUndefined();
  });

  it("does not dim non-zero source rows", async () => {
    render(<LogFilters {...baseProps} />);
    await openSources();
    const rendererBtn = screen.getByText(/^\*?renderer/).closest("button")!;
    expect(rendererBtn.classList.contains("text-text-secondary")).toBe(false);
    expect(rendererBtn.dataset.empty).toBeUndefined();
  });
});
