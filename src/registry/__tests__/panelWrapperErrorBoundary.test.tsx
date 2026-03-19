// @vitest-environment jsdom
import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

function ThrowingPanel() {
  throw new Error("Chunk load failed");
  return null;
}

describe("Panel wrapper ErrorBoundary + Suspense nesting", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ErrorBoundary outside Suspense catches render errors", () => {
    render(
      <ErrorBoundary variant="component" componentName="BrowserPane">
        <Suspense fallback={<div>Loading...</div>}>
          <ThrowingPanel />
        </Suspense>
      </ErrorBoundary>
    );

    expect(screen.getByText("BrowserPane Error")).toBeTruthy();
    expect(screen.getByText("Try Again")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("renders child normally when no error", () => {
    function GoodPanel() {
      return <div>Panel content</div>;
    }

    render(
      <ErrorBoundary variant="component" componentName="NotesPane">
        <Suspense fallback={<div>Loading...</div>}>
          <GoodPanel />
        </Suspense>
      </ErrorBoundary>
    );

    expect(screen.getByText("Panel content")).toBeTruthy();
  });
});
