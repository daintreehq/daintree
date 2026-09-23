// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WorktreeCardErrorFallback } from "../WorktreeCardErrorFallback";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";

function wrap(ui: React.ReactElement) {
  return <TooltipProvider>{ui}</TooltipProvider>;
}

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

const announceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("WorktreeCardErrorFallback", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders error message in dev mode", () => {
    const resetError = vi.fn();
    render(
      wrap(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />)
    );
    expect(screen.getByText("Card broke")).toBeTruthy();
  });

  it("renders generic message in production mode", () => {
    vi.stubEnv("DEV", false);
    const resetError = vi.fn();
    render(
      wrap(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />)
    );
    expect(screen.getByText("Couldn't show this worktree")).toBeTruthy();
    expect(screen.queryByText("Card broke")).toBeNull();
  });

  it("calls resetError when Try again is clicked", () => {
    const resetError = vi.fn();
    render(
      wrap(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />)
    );
    fireEvent.click(screen.getByText("Try again"));
    expect(resetError).toHaveBeenCalledOnce();
  });

  it("renders compact fallback when used as ErrorBoundary fallback prop", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowingCard() {
      throw new Error("Card render failed");
      return null;
    }

    render(
      <TooltipProvider>
        <ErrorBoundary
          variant="component"
          componentName="WorktreeCard"
          fallback={WorktreeCardErrorFallback}
          resetKeys={["wt-1"]}
          context={{ worktreeId: "wt-1" }}
        >
          <ThrowingCard />
        </ErrorBoundary>
      </TooltipProvider>
    );

    expect(screen.getByText("Card render failed")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    // Should NOT show the default ErrorFallback component variant
    expect(screen.queryByText("WorktreeCard Error")).toBeNull();
  });

  it("names the worktree it could not show, on screen and to screen readers", () => {
    vi.stubEnv("DEV", false);
    announceMock.mockClear();
    render(
      wrap(
        <WorktreeCardErrorFallback
          error={new Error("Card broke")}
          resetError={vi.fn()}
          displayName="feature/login"
        />
      )
    );
    expect(screen.getByText("Couldn't show feature/login")).toBeTruthy();
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock.mock.calls[0]![0]).toContain("feature/login");
  });

  it("swaps Try again for a window reload once a retry has failed", () => {
    vi.stubEnv("DEV", false);
    const resetError = vi.fn();
    render(
      wrap(
        <WorktreeCardErrorFallback
          error={new Error("Card broke")}
          resetError={resetError}
          displayName="feature/login"
          retryCount={1}
        />
      )
    );
    expect(screen.queryByText("Try again")).toBeNull();
    fireEvent.click(screen.getByText("Reload window"));
    expect(resetError).not.toHaveBeenCalled();
  });
});
