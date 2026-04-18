// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";
import { useErrorStore } from "@/store/errorStore";

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

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("Test render error");
  return <div>Child rendered</div>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
    vi.clearAllMocks();
    useErrorStore.getState().reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Child rendered")).toBeTruthy();
  });

  it("renders fallback when child throws", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Section Error")).toBeTruthy();
  });

  it("captures incidentId from addError and passes to fallback", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const errors = useErrorStore.getState().errors;
    expect(errors.length).toBe(1);

    const storeId = errors[0]!.id;
    const shortId = storeId.slice(-7);
    // In dev mode, incident ID is not displayed (only in prod)
    // but we can verify the error was added to the store
    expect(storeId).toMatch(/^error-\d+-[a-z0-9]{7}$/);
    expect(shortId).toHaveLength(7);
  });

  it("passes incidentId to logError context", async () => {
    const { logError } = await import("@/utils/logger");

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const errors = useErrorStore.getState().errors;
    const storeId = errors[0]!.id;

    expect(logError).toHaveBeenCalledWith(
      "React error boundary caught render error",
      expect.any(Error),
      expect.objectContaining({ incidentId: storeId })
    );
  });

  it("resets state when resetError is called and child stops throwing", () => {
    let shouldThrow = true;
    function ConditionalThrow() {
      if (shouldThrow) throw new Error("Test render error");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary variant="section">
        <ConditionalThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText("Section Error")).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Try Again"));

    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.queryByText("Section Error")).toBeNull();
  });

  it("provides onReport to section variant", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Report Issue")).toBeTruthy();
  });

  it("provides onReport to fullscreen variant", () => {
    render(
      <ErrorBoundary variant="fullscreen">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Report Issue")).toBeTruthy();
  });

  it("does not provide onReport to component variant", () => {
    render(
      <ErrorBoundary variant="component">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByText("Report Issue")).toBeNull();
  });

  it("renders incident ID in production mode for section variant", () => {
    vi.stubEnv("DEV", false);

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const errors = useErrorStore.getState().errors;
    const shortId = errors[0]!.id.slice(-7);

    expect(screen.getByText(`Error ID: ${shortId}`)).toBeTruthy();
    expect(screen.queryByText("Test render error")).toBeNull();
    expect(
      screen.getByText("Something went wrong. Please try again or contact support.")
    ).toBeTruthy();
  });

  it("hides technical details in production mode", () => {
    vi.stubEnv("DEV", false);

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByText("Technical Details")).toBeNull();
  });

  it("calls onError callback when provided", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary variant="section" onError={onError}>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({}));
  });
});
