// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue(undefined);

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

import { WorktreeLoadErrorBanner } from "../WorktreeLoadErrorBanner";

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
  dispatchMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorktreeLoadErrorBanner (#8400)", () => {
  it("renders the title and the sanitized, length-bounded error", () => {
    render(<WorktreeLoadErrorBanner error={"[31mNot a git repository[0m"} />);

    expect(screen.getByText("Couldn't load worktrees")).toBeTruthy();
    // ANSI escape sequences are stripped before render.
    expect(screen.getByText("Not a git repository")).toBeTruthy();
  });

  it("dispatches worktree.retryProjectLoad when Retry is clicked", async () => {
    render(<WorktreeLoadErrorBanner error="Not a git repository" />);

    fireEvent.click(screen.getByRole("button", { name: "Retry loading worktrees" }));

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith("worktree.retryProjectLoad", undefined, {
        source: "user",
      });
    });
  });

  it("uses the onRetry override and blocks concurrent retries", async () => {
    let resolveRetry: () => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        })
    );
    render(<WorktreeLoadErrorBanner error="boom" onRetry={onRetry} />);

    const button = screen.getByRole("button", { name: "Retry loading worktrees" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();

    resolveRetry();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Retry loading worktrees" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
  });
});
