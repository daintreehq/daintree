// @vitest-environment jsdom
import type React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ErrorBoundary, withErrorBoundary } from "../ErrorBoundary";
import { useErrorStore } from "@/store/errorStore";
import { captureRendererException } from "@/utils/rendererSentry";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

interface ElectronMock {
  system: { openExternal: ReturnType<typeof vi.fn> };
  clipboard?: { writeText: ReturnType<typeof vi.fn> };
}

function getElectronMock(): ElectronMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).electron;
}

function installElectronMock(): ElectronMock {
  const mock: ElectronMock = {
    system: { openExternal: vi.fn().mockResolvedValue(undefined) },
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.stubGlobal("electron", mock as any);
  return mock;
}

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
    // Default: Sentry SDK not initialized → null. Individual tests override.
    vi.mocked(captureRendererException).mockReturnValue(null);
    installElectronMock();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    expect(screen.getByText("Section stopped working")).toBeTruthy();
  });

  it("still adds the error to the store for cross-referencing", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const errors = useErrorStore.getState().errors;
    expect(errors.length).toBe(1);

    const storeId = errors[0]!.id;
    expect(storeId).toMatch(
      /^error-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
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

    expect(screen.getByText("Section stopped working")).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Reload pane"));

    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.queryByText("Section stopped working")).toBeNull();
  });

  it("provides onReport to section variant", () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Report issue")).toBeTruthy();
  });

  it("provides onReport to fullscreen variant", () => {
    render(
      <ErrorBoundary variant="fullscreen">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Report issue")).toBeTruthy();
  });

  it("does not provide onReport to component variant", () => {
    render(
      <ErrorBoundary variant="component">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByText("Report issue")).toBeNull();
  });

  it("does not show View logs button for component variant", () => {
    render(
      <ErrorBoundary variant="component">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.queryByTestId("error-fallback-logs")).toBeNull();
  });

  it("renders Sentry event ID as Error ID in production mode for section variant", () => {
    vi.stubEnv("DEV", false);
    vi.mocked(captureRendererException).mockReturnValue("sentry-event-deadbeef");

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const copyButton = screen.getByTestId("error-fallback-copy-id");
    expect(copyButton.textContent).toBe("sentry-event-deadbeef");
    expect(screen.queryByText("Test render error")).toBeNull();
    expect(
      screen.getByText("This pane crashed but the rest of Daintree is still running.")
    ).toBeTruthy();
  });

  it("falls back to store incident ID when Sentry returns null", () => {
    vi.stubEnv("DEV", false);
    vi.mocked(captureRendererException).mockReturnValue(null);

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const errors = useErrorStore.getState().errors;
    const storeId = errors[0]!.id;
    const copyButton = screen.getByTestId("error-fallback-copy-id");
    expect(copyButton.textContent).toBe(storeId);
  });

  it("dispatches a full-body deeplink when the report fits the URL budget", async () => {
    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue"));
    // Wait a microtask so the async handler resolves.
    await Promise.resolve();
    await Promise.resolve();

    const electron = getElectronMock();
    expect(electron.clipboard?.writeText).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      expect.objectContaining({
        url: expect.stringContaining("github.com/daintreehq/daintree/issues/new"),
      }),
      { source: "user" }
    );
  });

  it("copies full report to clipboard and notifies when payload exceeds URL budget", async () => {
    function ThrowGiantStack(): React.ReactElement {
      const error = new Error("Component blew up");
      // Force the encoded body well past 7000 even after stack truncation.
      error.stack =
        "Error: Component blew up\n" +
        Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
      throw error;
    }

    render(
      <ErrorBoundary variant="section">
        <ThrowGiantStack />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const electron = getElectronMock();
    expect(electron.clipboard?.writeText).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const clipboardArg = electron.clipboard!.writeText.mock.calls[0]![0] as string;
    expect(clipboardArg).toContain("**Component:**");
    expect(clipboardArg).toContain("Component blew up");

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Error details copied",
        transient: true,
      })
    );
    // Success branch is transient — no inbox entry should be written.
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Error details copied",
        inboxMessage: expect.anything(),
      })
    );

    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      expect.objectContaining({
        url: expect.stringContaining("copied%20to%20your%20clipboard"),
      }),
      { source: "user" }
    );
  });

  it("still opens the stub URL when clipboard write fails", async () => {
    const electron = getElectronMock();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
    (electron.clipboard!.writeText as any).mockRejectedValue(new Error("clipboard busy"));

    function ThrowGiantStack(): React.ReactElement {
      const error = new Error("Component blew up");
      error.stack =
        "Error: Component blew up\n" +
        Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
      throw error;
    }

    render(
      <ErrorBoundary variant="section">
        <ThrowGiantStack />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(electron.clipboard?.writeText).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Crash report didn't fit",
        inboxMessage: expect.any(String),
      })
    );
    // Failure branch must NOT be transient — the user needs the inbox entry.
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Crash report didn't fit",
        transient: true,
      })
    );
    expect(actionService.dispatch).toHaveBeenCalledWith("system.openExternal", expect.any(Object), {
      source: "user",
    });
  });

  it("flags clipboard fallback as failed when the clipboard API is absent", async () => {
    const mockElectron = getElectronMock();
    // Simulate a context where clipboard IPC is unavailable.
    delete mockElectron.clipboard;

    function ThrowGiantStack(): React.ReactElement {
      const error = new Error("Component blew up");
      error.stack =
        "Error: Component blew up\n" +
        Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
      throw error;
    }

    render(
      <ErrorBoundary variant="section">
        <ThrowGiantStack />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Crash report didn't fit",
      })
    );
  });

  it("deduplicates rapid double-clicks on Report Issue", async () => {
    function ThrowGiantStack(): React.ReactElement {
      const error = new Error("Component blew up");
      error.stack =
        "Error: Component blew up\n" +
        Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
      throw error;
    }

    render(
      <ErrorBoundary variant="section">
        <ThrowGiantStack />
      </ErrorBoundary>
    );

    const button = screen.getByText("Report issue");
    fireEvent.click(button);
    fireEvent.click(button); // second click while first is in-flight
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const electron = getElectronMock();
    expect(electron.clipboard?.writeText).toHaveBeenCalledTimes(1);
    expect(actionService.dispatch).toHaveBeenCalledTimes(1);
  });

  it("disables the Report issue button while the report is in flight", async () => {
    let resolveDispatch: ((value: { ok: true; result: undefined }) => void) | undefined;
    vi.mocked(actionService.dispatch).mockImplementationOnce(
      () =>
        new Promise<{ ok: true; result: undefined }>((resolve) => {
          resolveDispatch = resolve;
        })
    );

    function ThrowGiantStack(): React.ReactElement {
      const error = new Error("Component blew up");
      error.stack =
        "Error: Component blew up\n" +
        Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
      throw error;
    }

    render(
      <ErrorBoundary variant="section">
        <ThrowGiantStack />
      </ErrorBoundary>
    );

    const button = screen.getByTestId("error-fallback-report") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));

    resolveDispatch?.({ ok: true, result: undefined });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("clears the in-flight guard on reset so a new report can fire after recovery", async () => {
    // Pin actionService.dispatch to a never-resolving promise — simulates a
    // hung report. Without the field reset, the second click after recovery
    // would be silently swallowed by the still-true class-field guard.
    let resolveFirst: ((value: { ok: true; result: undefined }) => void) | undefined;
    vi.mocked(actionService.dispatch)
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; result: undefined }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ ok: true, result: undefined });

    let shouldThrow = true;
    function ConditionalThrow() {
      if (shouldThrow) {
        const error = new Error("Component blew up");
        error.stack =
          "Error: Component blew up\n" +
          Array.from({ length: 30 }, (_, i) => `    at frame${i} ${"x".repeat(800)}`).join("\n");
        throw error;
      }
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary variant="section">
        <ConditionalThrow />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue")); // first click — hangs
    await Promise.resolve();
    await Promise.resolve();
    expect(actionService.dispatch).toHaveBeenCalledTimes(1);

    // User gives up and recovers the pane while the first report is still in flight.
    shouldThrow = false;
    fireEvent.click(screen.getByText("Reload pane"));
    expect(screen.getByText("Recovered")).toBeTruthy();

    // Re-arm the throw and re-render to bring the fallback back.
    shouldThrow = true;
    rerender(
      <ErrorBoundary variant="section">
        <ConditionalThrow />
      </ErrorBoundary>
    );
    expect(screen.getByText("Section stopped working")).toBeTruthy();

    // Second click should now fire — the class-field guard was cleared on reset.
    fireEvent.click(screen.getByText("Report issue"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(actionService.dispatch).toHaveBeenCalledTimes(2);

    resolveFirst?.({ ok: true, result: undefined });
  });

  it("does not log the duplicate 'ErrorBoundary caught error' message", async () => {
    const { logError } = await import("@/utils/logger");

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(logError).not.toHaveBeenCalledWith(
      "ErrorBoundary caught error",
      expect.anything(),
      expect.anything()
    );
  });

  it("does nothing when window.electron is unavailable entirely", async () => {
    vi.unstubAllGlobals();

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText("Report issue"));
    await Promise.resolve();
    await Promise.resolve();

    expect(actionService.dispatch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows the technical details disclosure in production mode", () => {
    vi.stubEnv("DEV", false);

    render(
      <ErrorBoundary variant="section">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    const summary = screen.getByText("Technical details");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    // Collapsed by default so non-technical users aren't confronted with a stack trace.
    expect(details?.hasAttribute("open")).toBe(false);
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

  it("resets error state when numeric resetKeys change", () => {
    let key = 0;
    let shouldThrow = true;

    function ConditionalNumericThrow({ resetKey }: { resetKey: number }) {
      if (shouldThrow) throw new Error(`Test error at key ${resetKey}`);
      return <div>Recovered at key {resetKey}</div>;
    }

    const { rerender } = render(
      <ErrorBoundary variant="component" resetKeys={[key]}>
        <ConditionalNumericThrow resetKey={key} />
      </ErrorBoundary>
    );

    // DEV mode shows the actual error message for component variant
    expect(screen.getByText("Test error at key 0")).toBeTruthy();

    // Same key, still throwing — boundary stays in error state
    rerender(
      <ErrorBoundary variant="component" resetKeys={[key]}>
        <ConditionalNumericThrow resetKey={key} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Test error at key 0")).toBeTruthy();

    // Change key (simulating dialog close → reopen) and stop throwing
    key = 1;
    shouldThrow = false;
    rerender(
      <ErrorBoundary variant="component" resetKeys={[key]}>
        <ConditionalNumericThrow resetKey={key} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Recovered at key 1")).toBeTruthy();
  });

  it("calls onReset callback when reload button is clicked", () => {
    const onReset = vi.fn();
    let shouldThrow = true;
    function ConditionalThrow() {
      if (shouldThrow) throw new Error("Test render error");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary variant="section" onReset={onReset}>
        <ConditionalThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText("Section stopped working")).toBeTruthy();
    expect(onReset).not.toHaveBeenCalled();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Reload pane"));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("calls onReset before rendering recovered children", () => {
    const events: string[] = [];
    let shouldThrow = true;

    const onReset = vi.fn(() => {
      shouldThrow = false;
      events.push("onReset");
    });

    function ConditionalThrow() {
      events.push("child-render");
      if (shouldThrow) throw new Error("Test render error");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary variant="section" onReset={onReset}>
        <ConditionalThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText("Section stopped working")).toBeTruthy();

    events.length = 0;
    fireEvent.click(screen.getByText("Reload pane"));

    expect(events).toEqual(["onReset", "child-render"]);
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("logs error when onReset throws but still recovers", async () => {
    const { logError } = await import("@/utils/logger");
    const onReset = vi.fn(() => {
      throw new Error("onReset failed");
    });
    let shouldThrow = true;
    function ConditionalThrow() {
      if (shouldThrow) throw new Error("Test render error");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary variant="section" onReset={onReset}>
        <ConditionalThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText("Section stopped working")).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Reload pane"));

    expect(onReset).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("Error in onReset handler", expect.any(Error));
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("withErrorBoundary forwards onReset option", () => {
    const onReset = vi.fn();
    let shouldThrow = true;

    function TestComponent() {
      if (shouldThrow) throw new Error("Test error");
      return <div>Test component</div>;
    }

    const WrappedComponent = withErrorBoundary(TestComponent, {
      variant: "component",
      onReset,
    });

    const { rerender } = render(<WrappedComponent />);

    expect(screen.getByText("Test error")).toBeTruthy();

    shouldThrow = false;
    rerender(<WrappedComponent />);

    // Click the "Try again" button from the error fallback (component variant)
    fireEvent.click(screen.getByText("Try again"));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Test component")).toBeTruthy();
  });

  it("onReset is called when resetKeys change", () => {
    const onReset = vi.fn();
    let key = 0;
    let shouldThrow = true;

    function ConditionalNumericThrow({ resetKey }: { resetKey: number }) {
      if (shouldThrow) throw new Error(`Test error at key ${resetKey}`);
      return <div>Recovered at key {resetKey}</div>;
    }

    const { rerender } = render(
      <ErrorBoundary variant="component" resetKeys={[key]} onReset={onReset}>
        <ConditionalNumericThrow resetKey={key} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Test error at key 0")).toBeTruthy();
    expect(onReset).not.toHaveBeenCalled();

    // Change key to trigger reset
    key = 1;
    shouldThrow = false;
    rerender(
      <ErrorBoundary variant="component" resetKeys={[key]} onReset={onReset}>
        <ConditionalNumericThrow resetKey={key} />
      </ErrorBoundary>
    );

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recovered at key 1")).toBeTruthy();
  });
});
