// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TerminalAttachErrorBanner } from "../TerminalAttachErrorBanner";

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
  vi.clearAllMocks();
});

function renderBanner(overrides: Partial<React.ComponentProps<typeof TerminalAttachErrorBanner>>) {
  const onRetry = vi.fn();
  render(
    <TerminalAttachErrorBanner
      terminalId="term-1"
      error="Cannot read properties of undefined (reading 'setRenderer')"
      onRetry={onRetry}
      {...overrides}
    />
  );
  return { onRetry };
}

describe("TerminalAttachErrorBanner", () => {
  it("passes the terminal id to the retry handler", () => {
    const { onRetry } = renderBanner({ terminalId: "term-42" });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledWith("term-42");
  });

  it("reassures the user the process is still alive", () => {
    // The failure looks exactly like a hung agent from the outside, and that is
    // the wrong conclusion — the PTY is healthy and still recording.
    renderBanner({});

    expect(screen.getByRole("alert").textContent).toMatch(
      /process is still running and its output is being recorded/i
    );
  });

  it("surfaces the underlying error text", () => {
    renderBanner({ error: "boom-specific-detail" });

    expect(screen.getByRole("alert").textContent).toContain("boom-specific-detail");
  });

  it("renders without an error detail when the message is empty", () => {
    renderBanner({ error: "" });

    expect(screen.getByRole("alert").textContent).toMatch(/process is still running/i);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("strips terminal escape sequences out of the error text", () => {
    // The message can originate from terminal output, so it is untrusted.
    const esc = String.fromCharCode(27);
    renderBanner({ error: `${esc}[31mred${esc}[0m failure` });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("red failure");
    expect(alert.textContent).not.toContain(esc);
    expect(alert.textContent).not.toContain("[31m");
  });

  it("disables the retry button while a rebuild is in flight", () => {
    // The rebuild awaits an addon load, an open and a scrollback replay, so a
    // second click mid-flight would queue a redundant teardown.
    const { onRetry } = renderBanner({ isRetrying: true });

    const button = screen.getByRole("button", { name: "Retry" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("offers exactly one action and no dismiss", () => {
    // CLAUDE.md: an error banner carries at most ONE contextual recovery
    // action. Dismiss is deliberately absent — the banner is the only sign the
    // pane is dead, so it clears when the rebuild succeeds, not on a wave-away.
    renderBanner({});

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
