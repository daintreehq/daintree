// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WorktreeCardErrorFallback } from "../WorktreeCardErrorFallback";

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
});
