// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SpawnError, SpawnErrorCode } from "@shared/types/pty-host";

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Render the overflow popover open and in a tagged container so the inline
// primary action (outside) can be told apart from the demoted items (inside).
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

import { SpawnErrorBanner } from "../SpawnErrorBanner";

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

beforeEach(() => {
  dispatchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderBanner(
  code: SpawnErrorCode,
  overrides: Partial<{
    isRestarting: boolean;
    onRetry: (id: string) => void;
    onTrash: (id: string) => void;
    onUpdateCwd: (id: string) => void;
  }> = {}
) {
  const error: SpawnError = {
    code,
    message: `simulated ${code} error`,
  };
  return render(
    <SpawnErrorBanner
      terminalId="t-1"
      error={error}
      onUpdateCwd={overrides.onUpdateCwd ?? vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
      onTrash={overrides.onTrash ?? vi.fn()}
      isRestarting={overrides.isRestarting}
    />
  );
}

const overflow = () => screen.getByTestId("overflow-content");

describe("SpawnErrorBanner", () => {
  it("keeps a single inline action and moves Remove terminal into the overflow menu", () => {
    renderBanner("ENOENT");
    // Generic error → Retry is the sole inline action (outside the overflow).
    const retry = screen.getByRole("button", { name: /retry starting terminal/i });
    expect(overflow().contains(retry)).toBe(false);
    // Remove terminal is demoted into the overflow menu.
    const trash = screen.getByRole("button", { name: /move to trash/i });
    expect(overflow().contains(trash)).toBe(true);
    expect(trash.textContent).toContain("Remove terminal");
    // The overflow trigger keeps its accessible label.
    expect(screen.getByRole("button", { name: /more recovery options/i })).toBeTruthy();
  });

  it.each(["EMFILE", "EAGAIN", "ENOMEM", "ENXIO"] as const)(
    "promotes the terminal-limits action to the inline primary for %s",
    (code) => {
      renderBanner(code);
      const limits = screen.getByRole("button", { name: /open terminal limits settings/i });
      // Resource-limit errors make "Terminal limits" the primary inline action.
      expect(overflow().contains(limits)).toBe(false);
      // Retry is demoted into the overflow for these codes.
      expect(overflow().contains(screen.getByRole("button", { name: /retry starting terminal/i }))).toBe(
        true
      );
    }
  );

  it("does not render the terminal-limits action for unrelated codes", () => {
    renderBanner("ENOENT");
    expect(screen.queryByRole("button", { name: /open terminal limits settings/i })).toBeNull();
  });

  it("dispatches app.settings.openTab with the terminal/performance/panel-limits target", () => {
    renderBanner("EMFILE");
    fireEvent.click(screen.getByRole("button", { name: /open terminal limits settings/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "terminal", subtab: "performance", sectionId: "terminal-panel-limits" },
      { source: "user" }
    );
  });

  it("makes Change directory the inline primary action for an invalid working directory", () => {
    const onUpdateCwd = vi.fn();
    renderBanner("ENOTDIR", { onUpdateCwd });
    const changeDir = screen.getByRole("button", { name: /update working directory/i });
    expect(overflow().contains(changeDir)).toBe(false);
    fireEvent.click(changeDir);
    expect(onUpdateCwd).toHaveBeenCalledWith("t-1");
    // Retry is demoted into the overflow for cwd errors.
    expect(overflow().contains(screen.getByRole("button", { name: /retry starting terminal/i }))).toBe(
      true
    );
  });

  it("invokes onTrash from the overflow menu", () => {
    const onTrash = vi.fn();
    renderBanner("ENOENT", { onTrash });
    fireEvent.click(screen.getByRole("button", { name: /move to trash/i }));
    expect(onTrash).toHaveBeenCalledWith("t-1");
  });

  it("disables retry and shows aria-busy when isRestarting is true", () => {
    renderBanner("ENOENT", { isRestarting: true });
    const retry = screen.getByRole("button", { name: /retry starting terminal/i });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
  });

  it("does not invoke onRetry while isRestarting is true", () => {
    const onRetry = vi.fn();
    renderBanner("ENOENT", { isRestarting: true, onRetry });
    fireEvent.click(screen.getByRole("button", { name: /retry starting terminal/i }));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("invokes onRetry when not restarting", () => {
    const onRetry = vi.fn();
    renderBanner("ENOENT", { onRetry });
    fireEvent.click(screen.getByRole("button", { name: /retry starting terminal/i }));
    expect(onRetry).toHaveBeenCalledWith("t-1");
  });
});
