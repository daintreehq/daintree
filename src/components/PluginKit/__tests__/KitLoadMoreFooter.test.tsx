// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { KitLoadMoreFooter } from "../PluginKitCollectionChrome";

describe("KitLoadMoreFooter loading gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks activation at once but defers spinner and announcement", () => {
    const onLoadMore = vi.fn();
    const { container } = render(<KitLoadMoreFooter status="loading" onLoadMore={onLoadMore} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(button.hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS - 1);
    });
    expect(button.hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button.hasAttribute("data-loading")).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading more");
  });

  it("never shows the spinner when loading ends inside the gate", () => {
    const { container, rerender } = render(
      <KitLoadMoreFooter status="loading" onLoadMore={vi.fn()} />
    );
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS - 1);
    });
    rerender(<KitLoadMoreFooter status="idle" onLoadMore={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(UI_INLINE_LOADING_GATE_MS * 2);
    });
    expect(screen.getByRole("button").hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("loads on click when idle", () => {
    const onLoadMore = vi.fn();
    render(<KitLoadMoreFooter status="idle" onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
