// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
  it("input is reachable via aria-label and carries data-testid", () => {
    render(<FindBar find={makeFindState()} />);
    const input = screen.getByLabelText("Find in page") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("data-testid")).toBe("find-bar-input");
  });

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
});
