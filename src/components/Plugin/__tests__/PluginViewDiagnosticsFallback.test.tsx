// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginViewDiagnosticsFallback,
  type PluginViewDiagnosticsFallbackProps,
} from "../PluginViewDiagnosticsFallback";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

const announceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));

const writeTextMock = vi.fn<(text: string) => Promise<void>>();

// Both stacks carry a *distinct* username and a *distinct* secret sigil. The
// usernames catch a scrub that reaches only one of the two stacks; the tokens
// catch a downgrade from `scrubReportText` to path-only `scrubReportPath`,
// which would keep every path assertion green while leaking credentials.
const ALICE_TOKEN = `ghp_${"a".repeat(36)}`;
const BOB_TOKEN = `ghp_${"b".repeat(36)}`;
const STACK = `Error: boom (${ALICE_TOKEN})\n    at Widget (/Users/alice/plugins/acme/dashboard.js:10:5)`;
const COMPONENT_STACK = `\n    at Widget (/Users/bob/plugins/acme/dashboard.js:10:5) ${BOB_TOKEN}`;
/** Everything that must never survive redaction for an installed plugin. */
const SENSITIVE = ["/Users/alice", "/Users/bob", ALICE_TOKEN, BOB_TOKEN];

function makeError(message: string, stack?: string): Error {
  const error = new Error(message);
  error.stack = stack;
  return error;
}

function renderFallback(overrides: Partial<PluginViewDiagnosticsFallbackProps> = {}) {
  const props: PluginViewDiagnosticsFallbackProps = {
    error: makeError("Cannot read properties of undefined", STACK),
    errorInfo: { componentStack: COMPONENT_STACK },
    resetError: vi.fn(),
    incidentId: null,
    pluginId: "acme",
    pluginDisplayName: "Acme Tools",
    kindId: "acme.dashboard",
    panelDisplayName: "Dashboard",
    componentPath: "plugin://acme/dashboard.js",
    devMode: false,
    ...overrides,
  };
  return { props, ...render(<PluginViewDiagnosticsFallback {...props} />) };
}

const trace = () => screen.getByTestId("plugin-view-diagnostics-trace").textContent ?? "";

beforeEach(() => {
  dispatchMock.mockClear();
  announceMock.mockClear();
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PluginViewDiagnosticsFallback", () => {
  it("shows the plugin identity, module path and message", () => {
    renderFallback();

    const pane = screen.getByTestId("plugin-view-diagnostics").textContent ?? "";
    expect(pane).toContain("Acme Tools");
    expect(pane).toContain("acme.dashboard");
    expect(pane).toContain("plugin://acme/dashboard.js");
    expect(screen.getByTestId("plugin-view-diagnostics-message").textContent).toBe(
      "Cannot read properties of undefined"
    );
  });

  it("renders frames from both the stack and the component stack", () => {
    renderFallback({ devMode: true });

    // Assert the frames themselves, not the headings — a heading proves only
    // that the label was printed, not that any stack reached the pane.
    expect(trace()).toContain("dashboard.js:10:5");
    expect(trace()).toContain("/Users/bob");
  });

  // The bug this component exists to fix: a plugin author runs a *production*
  // Daintree, so a build-mode gate hides the trace from the one person who can
  // act on it. Vitest runs with DEV=true, so an `import.meta.env.DEV` gate would
  // wrongly unlock raw output here and fail this case.
  it("redacts an installed plugin's paths and secrets even though the app build is DEV", () => {
    renderFallback({ devMode: false });

    for (const secret of SENSITIVE) expect(trace()).not.toContain(secret);
    // Redaction must not cost the frame itself — the author still needs to see
    // which module and line threw.
    expect(trace()).toContain("dashboard.js:10:5");
  });

  it("leaves a dev-mode plugin's paths and secrets raw even though the app build is not DEV", () => {
    vi.stubEnv("DEV", false);

    renderFallback({ devMode: true });

    for (const secret of SENSITIVE) expect(trace()).toContain(secret);
  });

  // Redaction is about the user's data, not the plugin's. Scrubbing the message
  // would cost diagnostic signal for no leak benefit (#9427).
  it("never redacts the message", () => {
    renderFallback({
      devMode: false,
      error: makeError("Failed to load /Users/alice/config.json", STACK),
    });

    expect(screen.getByTestId("plugin-view-diagnostics-message").textContent).toBe(
      "Failed to load /Users/alice/config.json"
    );
  });

  it("copies the trace it renders and nothing sensitive beyond it", async () => {
    renderFallback({ devMode: false });

    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-copy"));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));
    const copied = writeTextMock.mock.calls[0]![0];
    expect(copied).toContain(trace());
    // Containment alone would still pass if the report appended a *raw* second
    // copy of either stack, so assert every sensitive value is absent outright.
    for (const secret of SENSITIVE) expect(copied).not.toContain(secret);
    expect(copied).toContain("plugin://acme/dashboard.js");
  });

  it("includes the error id in the pane and the copied report only when there is one", async () => {
    const { unmount } = renderFallback({ incidentId: "abc-123" });
    expect(screen.getByTestId("plugin-view-diagnostics").textContent).toContain("abc-123");
    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-copy"));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));
    expect(writeTextMock.mock.calls[0]![0]).toContain("Error ID: abc-123");
    unmount();

    writeTextMock.mockClear();
    renderFallback({ incidentId: null });
    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-copy"));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));
    expect(writeTextMock.mock.calls[0]![0]).not.toContain("Error ID:");
  });

  it("flips the copy button label without changing its accessible name", async () => {
    renderFallback();
    const button = screen.getByTestId("plugin-view-diagnostics-copy");
    expect(button.textContent).toBe("Copy diagnostics");

    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toBe("Copied"));
    expect(button.getAttribute("aria-label")).toBe("Copy diagnostics");
  });

  it("opens the log file from View logs", () => {
    renderFallback();

    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-logs"));

    expect(dispatchMock).toHaveBeenCalledWith("logs.openFile", undefined, { source: "user" });
  });

  it("routes Try again to the boundary's reset", () => {
    const resetError = vi.fn();
    renderFallback({ resetError });

    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-retry"));

    expect(resetError).toHaveBeenCalledTimes(1);
  });

  it("substitutes placeholders when the error carries no stacks", () => {
    renderFallback({ error: makeError("boom", undefined), errorInfo: undefined });

    expect(trace()).toContain("No stack trace available");
    expect(trace()).toContain("No component stack available");
  });

  it("falls back to a generic message when the error has none", () => {
    renderFallback({ error: makeError("", STACK) });

    expect(screen.getByTestId("plugin-view-diagnostics-message").textContent).toBe(
      "Unknown render error"
    );
  });

  it("announces the failure once for screen readers", () => {
    const { rerender, props } = renderFallback();
    rerender(<PluginViewDiagnosticsFallback {...props} />);

    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith("Dashboard error", "polite");
  });
});
