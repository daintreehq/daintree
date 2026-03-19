// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WorktreeCardErrorFallback } from "../WorktreeCardErrorFallback";
import { ErrorBoundary } from "@/components/ErrorBoundary";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
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
    render(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />);
    expect(screen.getByText("Card broke")).toBeTruthy();
  });

  it("renders generic message in production mode", () => {
    vi.stubEnv("DEV", false);
    const resetError = vi.fn();
    render(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />);
    expect(screen.getByText("Card failed to render")).toBeTruthy();
    expect(screen.queryByText("Card broke")).toBeNull();
  });

  it("calls resetError when retry is clicked", () => {
    const resetError = vi.fn();
    render(<WorktreeCardErrorFallback error={new Error("Card broke")} resetError={resetError} />);
    fireEvent.click(screen.getByText("Retry"));
    expect(resetError).toHaveBeenCalledOnce();
  });

  it("renders compact fallback when used as ErrorBoundary fallback prop", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowingCard() {
      throw new Error("Card render failed");
      return null;
    }

    render(
      <ErrorBoundary
        variant="component"
        componentName="WorktreeCard"
        fallback={WorktreeCardErrorFallback}
        resetKeys={["wt-1"]}
        context={{ worktreeId: "wt-1" }}
      >
        <ThrowingCard />
      </ErrorBoundary>
    );

    expect(screen.getByText("Card render failed")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    // Should NOT show the default ErrorFallback component variant
    expect(screen.queryByText("WorktreeCard Error")).toBeNull();
  });
});
