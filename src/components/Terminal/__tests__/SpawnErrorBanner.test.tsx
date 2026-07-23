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
import { SPAWN_ERROR_BANNER_COPY } from "../spawnErrorBannerCopy";

// Listing every variant explicitly (rather than `Object.keys() as SpawnErrorCode[]`)
// keeps the array's element type sound and forces the test to be updated when a
// new SpawnErrorCode is added.
const ALL_SPAWN_ERROR_CODES: readonly SpawnErrorCode[] = [
  "ENOENT",
  "EACCES",
  "ENOTDIR",
  "EIO",
  "EMFILE",
  "EAGAIN",
  "ENOMEM",
  "ENXIO",
  "EBUSY",
  "DISCONNECTED",
  "PENDING_SPAWNS_CAPPED",
  "TERMINAL_ALREADY_LIVE",
  "UNKNOWN",
] as const;

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
  vi.useRealTimers();
});

function renderBanner(
  code: SpawnErrorCode,
  overrides: Partial<{
    isRestarting: boolean;
    onRetry: (id: string) => void;
    onTrash: (id: string) => void;
    onUpdateCwd: (id: string) => void;
    errno: number;
    syscall: string;
    path: string;
    cwd: string;
  }> = {}
) {
  const error: SpawnError = {
    code,
    message: `simulated ${code} error`,
    errno: overrides.errno,
    syscall: overrides.syscall,
    path: overrides.path,
  };
  return render(
    <SpawnErrorBanner
      terminalId="t-1"
      error={error}
      cwd={overrides.cwd}
      onUpdateCwd={overrides.onUpdateCwd ?? vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
      onTrash={overrides.onTrash ?? vi.fn()}
      isRestarting={overrides.isRestarting}
    />
  );
}

const overflow = () => screen.getByTestId("overflow-content");

describe("SpawnErrorBanner", () => {
  it.each(ALL_SPAWN_ERROR_CODES)("renders a non-empty title for %s", (code) => {
    renderBanner(code);
    const title = SPAWN_ERROR_BANNER_COPY[code].title;
    expect(title.length).toBeGreaterThan(0);
    expect(screen.getByText(title)).toBeTruthy();
  });

  // Hardcoded oracles — guard against a copy-table transposition that the
  // table-driven test above would silently accept.
  it.each([
    ["ENOENT", "Couldn't find shell or command"],
    ["EACCES", "Couldn't execute shell"],
    ["ENOTDIR", "Invalid working directory"],
    ["PENDING_SPAWNS_CAPPED", "Too many pending restarts"],
    ["TERMINAL_ALREADY_LIVE", "Terminal already running"],
    ["UNKNOWN", "Couldn't start terminal"],
  ] as const)("renders the expected title for %s", (code, expected) => {
    renderBanner(code);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("explains the kept-alive process and keeps Retry inline for TERMINAL_ALREADY_LIVE", () => {
    const onRetry = vi.fn();
    renderBanner("TERMINAL_ALREADY_LIVE", { onRetry });
    // Assert the semantic shape (why it happened + how to recover), not the
    // exact literal — matching the whole source-of-truth string is tautological.
    expect(screen.getByText(/already has a running process/i)).toBeTruthy();
    expect(screen.getByText(/retry to restart it/i)).toBeTruthy();
    // Retry is the sole inline primary action (outside the overflow) for this
    // generic recovery — clicking it restarts the terminal.
    const retry = screen.getByRole("button", { name: /retry starting terminal/i });
    expect(overflow().contains(retry)).toBe(false);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith("t-1");
  });

  it("renders the UNKNOWN code with the message as description", () => {
    renderBanner("UNKNOWN");
    expect(screen.getByText(/simulated UNKNOWN error/i)).toBeTruthy();
  });

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
      expect(
        overflow().contains(screen.getByRole("button", { name: /retry starting terminal/i }))
      ).toBe(true);
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
    expect(
      overflow().contains(screen.getByRole("button", { name: /retry starting terminal/i }))
    ).toBe(true);
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

  it("disables the demoted overflow Retry while restarting and does not invoke onRetry", () => {
    const onRetry = vi.fn();
    // ENOTDIR makes Change directory the primary, so Retry is demoted to overflow.
    renderBanner("ENOTDIR", { isRestarting: true, onRetry });
    const retry = screen.getByRole("button", { name: /retry starting terminal/i });
    expect(overflow().contains(retry)).toBe(true);
    expect(retry.hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  describe("diagnostic fields", () => {
    it("renders no diagnostics section when errno/syscall/path are all absent", () => {
      renderBanner("ENOENT");
      expect(screen.queryByRole("button", { name: /copy diagnostics/i })).toBeNull();
      expect(screen.queryByTestId("diagnostic-payload")).toBeNull();
    });

    it("renders all three diagnostic fields when present", () => {
      renderBanner("ENOENT", { errno: -2, syscall: "spawn", path: "/usr/bin/zsh" });
      const payload = screen.getByTestId("diagnostic-payload");
      expect(payload.textContent).toBe("errno=-2 syscall=spawn path=/usr/bin/zsh");
    });

    it("omits absent fields from the payload (errno only)", () => {
      renderBanner("EACCES", { errno: 13 });
      expect(screen.getByTestId("diagnostic-payload").textContent).toBe("errno=13");
    });

    it("omits absent fields from the payload (path only)", () => {
      renderBanner("ENOENT", { path: "/bin/missing" });
      expect(screen.getByTestId("diagnostic-payload").textContent).toBe("path=/bin/missing");
    });

    it("still renders the copy button when clipboard is unavailable, but clicking is a no-op", () => {
      const original = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      try {
        renderBanner("ENOENT", { errno: -2, syscall: "spawn", path: "/bin/x" });
        const button = screen.getByRole("button", { name: /copy diagnostics/i });
        expect(button).toBeTruthy();
        expect(() => fireEvent.click(button)).not.toThrow();
        // Label stays at "Copy diagnostics" (never flips to "Diagnostics copied").
        expect(screen.queryByRole("button", { name: /diagnostics copied/i })).toBeNull();
      } finally {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: original,
        });
      }
    });
  });
});
