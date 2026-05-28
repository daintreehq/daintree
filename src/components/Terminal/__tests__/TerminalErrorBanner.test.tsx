// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TerminalRestartError } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Render the overflow popover open so the demoted trash button is queryable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-content">{children}</div>
  ),
}));

import { TerminalErrorBanner } from "../TerminalErrorBanner";

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
  error: TerminalRestartError,
  overrides: Partial<{
    isRestarting: boolean;
    onRetry: (id: string) => void;
    onTrash: (id: string) => void;
    onUpdateCwd: (id: string) => void;
  }> = {}
) {
  return render(
    <TerminalErrorBanner
      terminalId="t-1"
      error={error}
      onUpdateCwd={overrides.onUpdateCwd ?? vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
      onTrash={overrides.onTrash ?? vi.fn()}
      isRestarting={overrides.isRestarting}
    />
  );
}

describe("TerminalErrorBanner", () => {
  it("renders the restart-failed title", () => {
    renderBanner({
      message: "child process died",
      recoverable: true,
      timestamp: 1,
    });
    expect(screen.getByText(/terminal restart failed/i)).toBeTruthy();
  });

  it("does not show Change directory for non-ENOENT errors", () => {
    renderBanner({
      message: "child process died",
      recoverable: true,
      timestamp: 1,
    });
    expect(screen.queryByRole("button", { name: /update working directory/i })).toBeNull();
  });

  it("shows Change directory for ENOENT with failed cwd context", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    expect(screen.getByRole("button", { name: /update working directory/i })).toBeTruthy();
  });

  it("hides Change directory when error is non-recoverable", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: false,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    expect(screen.queryByRole("button", { name: /update working directory/i })).toBeNull();
  });

  it("renders the failed cwd in the context line", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    expect(screen.getByText(/directory:.*\/missing\/dir/i)).toBeTruthy();
  });

  it("invokes onRetry with the terminal id", () => {
    const onRetry = vi.fn();
    renderBanner(
      {
        message: "failed",
        recoverable: true,
        timestamp: 1,
      },
      { onRetry }
    );
    fireEvent.click(screen.getByRole("button", { name: /retry restart/i }));
    expect(onRetry).toHaveBeenCalledWith("t-1");
  });

  it("invokes onTrash with the terminal id", () => {
    const onTrash = vi.fn();
    renderBanner(
      {
        message: "failed",
        recoverable: true,
        timestamp: 1,
      },
      { onTrash }
    );
    fireEvent.click(screen.getByRole("button", { name: /move to trash/i }));
    expect(onTrash).toHaveBeenCalledWith("t-1");
  });

  it("disables retry and shows aria-busy when isRestarting is true", () => {
    renderBanner(
      {
        message: "failed",
        recoverable: true,
        timestamp: 1,
      },
      { isRestarting: true }
    );
    const retry = screen.getByRole("button", { name: /retry restart/i });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
  });
});
