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
const CAROL_TOKEN = `ghp_${"c".repeat(36)}`;
/** Carries a path and a token in the one field #12281 shipped raw. */
const LEAKY_MESSAGE = `Failed to load /Users/carol/config.json ${CAROL_TOKEN}`;
const STACK = `Error: boom (${ALICE_TOKEN})\n    at Widget (/Users/alice/plugins/acme/dashboard.js:10:5)`;
const COMPONENT_STACK = `\n    at Widget (/Users/bob/plugins/acme/panel.js:20:7) ${BOB_TOKEN}`;
/** Everything that must never survive redaction for an installed plugin. */
const SENSITIVE = ["/Users/alice", "/Users/bob", ALICE_TOKEN, BOB_TOKEN];
/** Only the cases that actually render a leaky message or cause assert these. */
const CAROL_SENSITIVE = ["/Users/carol", CAROL_TOKEN];

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
    // which module and line threw. Both stacks, with distinct locations, so
    // one surviving cannot stand in for the other.
    expect(trace()).toContain("dashboard.js:10:5");
    expect(trace()).toContain("panel.js:20:7");
  });

  it("leaves a dev-mode plugin's paths and secrets raw even though the app build is not DEV", () => {
    vi.stubEnv("DEV", false);

    renderFallback({ devMode: true });

    for (const secret of SENSITIVE) expect(trace()).toContain(secret);
  });

  // The message is plugin-authored, untrusted text: the author decides whether
  // it carries a path or a token, so a report labelled redacted must scrub it
  // too (#12281). Not a reversal of #9427 — the sibling ErrorFallback shows
  // fixed first-party copy in production and the raw message only under
  // `import.meta.env.DEV`, so it has no untrusted message to redact. This pane
  // deliberately shows plugin text to a production user, which is why it must.
  it("redacts the message an installed plugin threw", () => {
    renderFallback({ devMode: false, error: makeError(LEAKY_MESSAGE, STACK) });

    expect(screen.getByTestId("plugin-view-diagnostics-message").textContent).toBe(
      "Failed to load /Users/USER/config.json [REDACTED]"
    );
  });

  it("leaves a dev-mode plugin's message raw", () => {
    renderFallback({ devMode: true, error: makeError(LEAKY_MESSAGE, STACK) });

    expect(screen.getByTestId("plugin-view-diagnostics-message").textContent).toBe(LEAKY_MESSAGE);
  });

  // An unlabelled raw view is how #12281 happened: the pane claimed redaction
  // for the trace while the message beside it was untouched.
  it("says which document it is showing", () => {
    const { unmount } = renderFallback({ devMode: false });
    expect(screen.getByTestId("plugin-view-diagnostics-mode").textContent).toBe("redacted");
    unmount();

    renderFallback({ devMode: true });
    expect(screen.getByTestId("plugin-view-diagnostics-mode").textContent).toBe("raw (dev mode)");
  });

  it("renders the cause chain the stack alone cannot show", () => {
    const cause = makeError(
      `inner /Users/carol/x ${CAROL_TOKEN}`,
      "Error: inner\n    at f (a.js:1:1)"
    );
    const error = makeError("outer", STACK);
    Object.assign(error, { cause });

    renderFallback({ devMode: false, error });

    expect(trace()).toContain("Caused by: Error: inner");
    expect(trace()).toContain("a.js:1:1");
    for (const secret of [...SENSITIVE, ...CAROL_SENSITIVE]) expect(trace()).not.toContain(secret);
  });

  // The manifest supplies the identity, so the plugin author controls it — a
  // pane that prints it raw under "Report: redacted" is #12281 again in a
  // different field.
  it("redacts the manifest identity it prints beside the redacted label", () => {
    renderFallback({
      devMode: false,
      pluginDisplayName: `Acme ${CAROL_TOKEN}`,
      componentPath: "plugin:///Users/carol/dev/acme/dashboard.js",
    });

    const pane = screen.getByTestId("plugin-view-diagnostics").textContent ?? "";
    for (const secret of CAROL_SENSITIVE) expect(pane).not.toContain(secret);
    // The identity still has to identify something.
    expect(pane).toContain("Acme");
    expect(pane).toContain("dashboard.js");
  });

  it("copies the trace it renders and nothing sensitive beyond it", async () => {
    renderFallback({ devMode: false, error: makeError(LEAKY_MESSAGE, STACK) });

    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-copy"));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));
    const copied = writeTextMock.mock.calls[0]![0];
    expect(copied).toContain(trace());
    // Containment alone would still pass if the report appended a *raw* second
    // copy of either stack, so assert every sensitive value is absent outright.
    for (const secret of [...SENSITIVE, ...CAROL_SENSITIVE]) expect(copied).not.toContain(secret);
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

  it("offers Close panel when the host supplies a close callback (#11301)", () => {
    const onRequestClose = vi.fn();
    renderFallback({ onRequestClose });

    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-close"));

    // Without this the pane is a dead end: `panel.openPluginPanel` defaults to
    // `reuseExisting: true`, so re-running the plugin's own open command just
    // refocuses the panel that is already failing.
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("omits Close panel entirely when the host offers no close", () => {
    renderFallback();

    // Rendered-and-inert would read as a broken button; the host decides.
    expect(screen.queryByTestId("plugin-view-diagnostics-close")).toBeNull();
    expect(screen.getByTestId("plugin-view-diagnostics-retry")).toBeTruthy();
  });

  it("places Close panel next to Try again rather than off in the trace", () => {
    renderFallback({ onRequestClose: vi.fn() });

    const retry = screen.getByTestId("plugin-view-diagnostics-retry");
    const close = screen.getByTestId("plugin-view-diagnostics-close");
    // The issue's ask is specifically that the escape hatch sits where the
    // failure is shown, beside the recovery action — not that it carries any
    // particular class.
    expect(close.parentElement).toBe(retry.parentElement);
    expect(retry.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
