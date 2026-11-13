// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ProblemsContent } from "../ProblemsContent";
import { useErrorStore, type ErrorRecord } from "@/store";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function seed(messages: string[]) {
  useErrorStore.setState({
    errors: messages.map((message, i) => ({
      id: `err-${i}`,
      timestamp: 1_700_000_000_000 + i,
      type: "unknown",
      message,
      isTransient: false,
      dismissed: false,
    })) as ErrorRecord[],
    isPanelOpen: false,
    lastErrorTime: 0,
  });
}

function dismissButtons() {
  return screen.getAllByRole("button", { name: "Dismiss problem" });
}

function toggleFor(message: string) {
  return screen.getByText(message).closest("button")!;
}

describe("ProblemsContent — focus after dismissing a row", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({ tabFocusRequest: null });
  });

  it("moves focus to the next row", () => {
    seed(["first", "second", "third"]);
    render(<ProblemsContent />);
    const dismiss = dismissButtons()[0]!;
    dismiss.focus();
    fireEvent.click(dismiss, { detail: 1 });

    expect(screen.queryByText("first")).toBeNull();
    expect(document.activeElement).toBe(toggleFor("second"));
  });

  it("falls back to the previous row when the last one is dismissed", () => {
    seed(["first", "second"]);
    render(<ProblemsContent />);
    const dismiss = dismissButtons()[1]!;
    dismiss.focus();
    fireEvent.click(dismiss, { detail: 1 });

    expect(document.activeElement).toBe(toggleFor("first"));
  });

  it("asks the dock for the tab bar when no row is left", () => {
    seed(["only"]);
    render(<ProblemsContent />);
    const dismiss = dismissButtons()[0]!;
    dismiss.focus();
    act(() => {
      fireEvent.click(dismiss, { detail: 0 });
    });

    expect(useDiagnosticsStore.getState().tabFocusRequest).toEqual({ focusVisible: true });
  });
});
