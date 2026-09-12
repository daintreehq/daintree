// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TerminalReconnectError } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ReconnectErrorBanner } from "../ReconnectErrorBanner";

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
  type: TerminalReconnectError["type"],
  overrides: Partial<{
    isRestarting: boolean;
    onRestart: (id: string) => void;
    onDismiss: (id: string) => void;
  }> = {}
) {
  const error: TerminalReconnectError = {
    type,
    message: `simulated ${type} error`,
    timestamp: 1700000000000,
  };
  return render(
    <ReconnectErrorBanner
      terminalId="t-1"
      error={error}
      onDismiss={overrides.onDismiss ?? vi.fn()}
      onRestart={overrides.onRestart ?? vi.fn()}
      isRestarting={overrides.isRestarting}
    />
  );
}

describe("ReconnectErrorBanner", () => {
  it.each(["timeout", "not_found", "error"] as const)(
    "renders the retry action with the Retry label for %s",
    (type) => {
      renderBanner(type);
      const button = screen.getByRole("button", { name: /retry reconnecting/i });
      expect(button.textContent).toContain("Retry");
    }
  );

  it("renders the timeout title for timeout errors", () => {
    renderBanner("timeout");
    expect(screen.getByText(/reconnection timed out/i)).toBeTruthy();
  });

  it("renders the not-found title for not_found errors", () => {
    renderBanner("not_found");
    expect(screen.getByText(/previous session not found/i)).toBeTruthy();
  });

  it("renders the generic title for error errors", () => {
    renderBanner("error");
    expect(screen.getByText(/reconnection failed/i)).toBeTruthy();
  });

  it("invokes onRestart with the terminal id when retry is clicked", () => {
    const onRestart = vi.fn();
    renderBanner("error", { onRestart });
    fireEvent.click(screen.getByRole("button", { name: /retry reconnecting/i }));
    expect(onRestart).toHaveBeenCalledWith("t-1");
  });

  it("disables retry and sets aria-busy when isRestarting is true", () => {
    renderBanner("error", { isRestarting: true });
    const button = screen.getByRole("button", { name: /retry reconnecting/i });
    // Loading keeps focus on the control (no native disabled) and blocks activation.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("does not invoke onRestart while isRestarting is true", () => {
    const onRestart = vi.fn();
    renderBanner("error", { isRestarting: true, onRestart });
    fireEvent.click(screen.getByRole("button", { name: /retry reconnecting/i }));
    expect(onRestart).not.toHaveBeenCalled();
  });
});
