// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "../FindBar";
import type { FindInPageState } from "@/hooks/useFindInPage";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

function makeFindState(overrides: Partial<FindInPageState> = {}): FindInPageState {
  return {
    isOpen: true,
    query: "",
    activeMatch: 0,
    matchCount: 0,
    isPending: false,
    inputRef: { current: null },
    isComposingRef: { current: false },
    open: vi.fn(),
    close: vi.fn(),
    setQuery: vi.fn(),
    goNext: vi.fn(),
    goPrev: vi.fn(),
    matchCase: false,
    toggleMatchCase: vi.fn(),
    ...overrides,
  };
}

describe("FindBar accessibility", () => {
  it("input aria-describedby matches counter span id and counter has live-region attrs", () => {
    const { container } = render(<FindBar find={makeFindState({ query: "foo", matchCount: 3 })} />);
    const input = container.querySelector('input[aria-label="Find in page"]') as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const counter = container.querySelector(`[id="${describedBy}"]`);
    expect(counter).not.toBeNull();
    expect(counter?.getAttribute("role")).toBe("status");
    expect(counter?.getAttribute("aria-atomic")).toBe("true");
  });

  it("counter span retains role=status before any query is entered (live region exists on mount)", () => {
    const { container } = render(<FindBar find={makeFindState({ query: "" })} />);
    const input = container.querySelector('input[aria-label="Find in page"]') as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby")!;
    const counter = container.querySelector(`[id="${describedBy}"]`);
    expect(counter?.getAttribute("role")).toBe("status");
  });

  it("match-case button has aria-pressed reflecting matchCase state", () => {
    const { rerender } = render(<FindBar find={makeFindState({ matchCase: false })} />);
    const btn = screen.getByLabelText("Match case");
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    rerender(<FindBar find={makeFindState({ matchCase: true })} />);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("match-case button calls toggleMatchCase on click", () => {
    const toggleFn = vi.fn();
    render(<FindBar find={makeFindState({ toggleMatchCase: toggleFn })} />);
    screen.getByLabelText("Match case").click();
    expect(toggleFn).toHaveBeenCalledTimes(1);
  });
});

describe("FindBar count", () => {
  function counter(): HTMLElement {
    const id = screen.getByLabelText("Find in page").getAttribute("aria-describedby");
    const node = document.getElementById(id ?? "");
    if (!node) throw new Error("no counter");
    return node;
  }

  it("says nothing while the page hasn't answered the query", () => {
    render(<FindBar find={makeFindState({ query: "foo", matchCount: 0, isPending: true })} />);
    expect(counter().textContent).toBe("");
  });

  it("reports no matches once the page has answered with none", () => {
    render(<FindBar find={makeFindState({ query: "foo", matchCount: 0, isPending: false })} />);
    expect(counter().textContent).toBe("No matches");
  });

  it("reports the count once the page has answered", () => {
    render(
      <FindBar
        find={makeFindState({ query: "foo", activeMatch: 2, matchCount: 5, isPending: false })}
      />
    );
    expect(counter().textContent).toBe("2 of 5");
  });

  it("keeps one live region through a pending search, styled as no result only once settled", () => {
    const { rerender } = render(
      <FindBar find={makeFindState({ query: "", matchCount: 0, isPending: false })} />
    );
    const node = counter();
    const idleClass = node.className;

    rerender(<FindBar find={makeFindState({ query: "foo", matchCount: 0, isPending: true })} />);
    expect(counter()).toBe(node);
    expect(node.textContent).toBe("");
    expect(node.className).toBe(idleClass);

    rerender(<FindBar find={makeFindState({ query: "foo", matchCount: 0, isPending: false })} />);
    expect(counter()).toBe(node);
    expect(node.textContent).toBe("No matches");
    expect(node.className).not.toBe(idleClass);
  });

  it("ends a composition its field can no longer finish when the bar unmounts", () => {
    const isComposingRef = { current: false };
    const { unmount } = render(<FindBar find={makeFindState({ isComposingRef })} />);
    fireEvent.compositionStart(screen.getByLabelText("Find in page"));
    expect(isComposingRef.current).toBe(true);

    unmount();
    expect(isComposingRef.current).toBe(false);
  });
});

describe("FindBar keyboard", () => {
  it("closes on Escape from a focused option, not only from the field", () => {
    const close = vi.fn();
    render(<FindBar find={makeFindState({ close })} />);
    fireEvent.keyDown(screen.getByLabelText("Match case"), { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the keys it handles from reaching the pane's own shortcuts", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <FindBar find={makeFindState({ query: "foo", matchCount: 2 })} />
      </div>
    );
    const input = screen.getByLabelText("Find in page");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "g", metaKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "a" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to an IME composition in progress", () => {
    const close = vi.fn();
    render(<FindBar find={makeFindState({ close, isComposingRef: { current: true } })} />);
    fireEvent.keyDown(screen.getByLabelText("Find in page"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
