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
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...props}>{children}</button>,
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
    expect(screen.queryByRole("button", { name: /^change directory$/i })).toBeNull();
  });

  it("shows Change directory for ENOENT with failed cwd context", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    expect(screen.getByRole("button", { name: /^change directory$/i })).toBeTruthy();
  });

  it("hides Change directory when error is non-recoverable", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: false,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    expect(screen.queryByRole("button", { name: /^change directory$/i })).toBeNull();
  });

  it("renders the failed cwd in the context line", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    const line = screen.getByTitle("Directory: /missing/dir");
    expect(line.textContent).toBe("Directory: /missing/dir");
  });

  it("keeps the final path segment of a long cwd in its own unclipped span", () => {
    renderBanner({
      message: "ENOENT",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/Users/someone/Projects/a/very/deep/tree/packages/runtime" },
    });
    const line = screen.getByTitle(/Directory: .*\/runtime$/);
    // The head gives way first; the tail — the part that names the directory —
    // is a separate span, so middle truncation never eats it.
    expect(line.lastElementChild?.textContent).toBe("/runtime");
    expect(line.textContent).toBe(
      "Directory: /Users/someone/Projects/a/very/deep/tree/packages/runtime"
    );
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
    fireEvent.click(screen.getByRole("button", { name: /^remove terminal$/i }));
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
    // Loading keeps focus on the control (no native disabled) and blocks activation.
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry.getAttribute("aria-busy")).toBe("true");
  });

  it("names every labelled control with the words it shows", () => {
    renderBanner({
      message: "gone",
      code: "ENOENT",
      recoverable: true,
      timestamp: 1,
      context: { failedCwd: "/missing/dir" },
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
      const visible = button.textContent?.trim();
      const name = button.getAttribute("aria-label");
      if (visible && name) expect(name.toLowerCase()).toContain(visible.toLowerCase());
    }
  });

  it("offers the whole message from the overflow even when the description clips it", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const message = `${"a".repeat(300)} middle cause ${"b".repeat(300)}`;
      renderBanner({ message, code: "EIO", recoverable: false, timestamp: 1 });
      expect(screen.queryByText(/middle cause/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^copy error$/i }));
      expect(writeText).toHaveBeenCalledWith(message);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
    }
  });
});
