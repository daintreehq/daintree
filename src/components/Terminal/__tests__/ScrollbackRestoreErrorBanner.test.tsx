// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TerminalScrollbackRestoreError } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ScrollbackRestoreErrorBanner } from "../ScrollbackRestoreErrorBanner";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderBanner(
  type: TerminalScrollbackRestoreError["type"],
  overrides: Partial<{
    message: string;
    isRestarting: boolean;
    onRestart: (id: string) => void;
    onDismiss: (id: string) => void;
  }> = {}
) {
  const error: TerminalScrollbackRestoreError = {
    type,
    message: overrides.message ?? `simulated ${type} error`,
    timestamp: 1700000000000,
  };
  return render(
    <ScrollbackRestoreErrorBanner
      terminalId="t-1"
      error={error}
      onDismiss={overrides.onDismiss ?? vi.fn()}
      onRestart={overrides.onRestart ?? vi.fn()}
      isRestarting={overrides.isRestarting}
    />
  );
}

describe("ScrollbackRestoreErrorBanner", () => {
  it("renders the timeout title for timeout errors", () => {
    renderBanner("timeout");
    expect(screen.getByText(/scrollback restore timed out/i)).toBeTruthy();
  });

  it("renders the parse title for parse errors", () => {
    renderBanner("parse");
    expect(screen.getByText(/scrollback contents couldn't be replayed/i)).toBeTruthy();
  });

  it("renders the generic title for error type", () => {
    renderBanner("error");
    expect(screen.getByText(/scrollback restore failed/i)).toBeTruthy();
  });

  it("includes the message text in the description for the error type", () => {
    renderBanner("error", { message: "boom from disk" });
    expect(screen.getByText(/boom from disk/i)).toBeTruthy();
  });

  it("does not include the raw message in the description for timeout type", () => {
    renderBanner("timeout", { message: "should not appear" });
    expect(screen.queryByText(/should not appear/i)).toBeNull();
  });

  it("invokes onRestart with the terminal id when reset is clicked", () => {
    const onRestart = vi.fn();
    renderBanner("error", { onRestart });
    fireEvent.click(screen.getByRole("button", { name: /reset terminal/i }));
    expect(onRestart).toHaveBeenCalledWith("t-1");
  });

  it("invokes onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    renderBanner("error", { onDismiss });
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith("t-1");
  });

  it("disables reset and shows aria-busy when isRestarting is true", () => {
    renderBanner("error", { isRestarting: true });
    const button = screen.getByRole("button", { name: /reset terminal/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
