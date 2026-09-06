/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiagnosticsPanel, describeDiagnosticEvent, describeUpstream } from "../DiagnosticsPanel";
import type {
  DevPreviewDiagnosticEvent,
  DevPreviewDiagnosticsResult,
} from "@shared/types/ipc/devPreview";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const getDiagnosticsMock = vi.fn<() => Promise<DevPreviewDiagnosticsResult>>();

function makeResult(
  events: DevPreviewDiagnosticEvent[],
  overrides: Partial<NonNullable<DevPreviewDiagnosticsResult["session"]>> = {}
): DevPreviewDiagnosticsResult {
  return {
    session: {
      panelId: "panel-1",
      projectId: "project-1",
      status: "running",
      generation: 2,
      updatedAt: Date.now(),
      allocatedPort: 5173,
      detectedUrl: "http://localhost:5173",
      upstream: { kind: "ok", port: 5173, isHttps: false },
      crashLoop: { count: 0, stopped: false, backoffPending: false },
      restoredFromManifest: false,
      events,
      ...overrides,
    },
    proxy: { port: 43000, usedPortFallback: false },
  };
}

describe("DiagnosticsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("window", Object.assign(window, {}));
    (window as unknown as { electron: unknown }).electron = {
      devPreview: { getDiagnostics: getDiagnosticsMock },
    };
    getDiagnosticsMock.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
    vi.restoreAllMocks();
  });

  it("renders the empty state with a next action when the timeline is empty", async () => {
    getDiagnosticsMock.mockResolvedValue(makeResult([]));
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="stopped" />);

    expect(await screen.findByText(/No lifecycle events yet/i)).toBeTruthy();
    expect(screen.getByText(/Start the dev server/i)).toBeTruthy();
  });

  it("renders newest events first with summary fields", async () => {
    getDiagnosticsMock.mockResolvedValue(
      makeResult([
        { type: "spawned", at: 1000, seq: 0, generation: 1, terminalId: "t-1", port: 5173 },
        { type: "url-detected", at: 2000, seq: 1, generation: 1, url: "http://localhost:5173" },
      ])
    );
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);

    const items = await screen.findAllByRole("listitem");
    expect(items[0]!.textContent).toContain("URL detected");
    expect(items[1]!.textContent).toContain("Dev server spawned");

    expect(screen.getByText("Allocated port")).toBeTruthy();
    expect(screen.getByText("localhost:5173")).toBeTruthy();
  });

  it("shows the coalesced count on repeated proxy failures", async () => {
    getDiagnosticsMock.mockResolvedValue(
      makeResult([
        { type: "proxy-502", at: 1000, seq: 0, generation: 1, cause: "upstream-refused", count: 7 },
      ])
    );
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);

    expect(await screen.findByText("×7")).toBeTruthy();
  });

  it("keeps long detail text reachable via the title attribute", async () => {
    const longUrl = `http://localhost:5173/${"a".repeat(150)}`;
    getDiagnosticsMock.mockResolvedValue(
      makeResult([{ type: "url-detected", at: 1000, seq: 0, generation: 1, url: longUrl }])
    );
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);

    const item = (await screen.findAllByRole("listitem"))[0]!;
    const detail = item.querySelector(`[title="${longUrl}"]`);
    expect(detail).toBeTruthy();
  });

  it("refetches when the dev-server status changes", async () => {
    getDiagnosticsMock.mockResolvedValue(makeResult([]));
    const { rerender } = render(
      <DiagnosticsPanel paneId="panel-1" projectId="project-1" status="starting" />
    );
    await waitFor(() => expect(getDiagnosticsMock).toHaveBeenCalledTimes(1));

    rerender(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);
    await waitFor(() => expect(getDiagnosticsMock).toHaveBeenCalledTimes(2));
  });

  it("refetches on the refresh button", async () => {
    getDiagnosticsMock.mockResolvedValue(makeResult([]));
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);
    await waitFor(() => expect(getDiagnosticsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh diagnostics" }));
    await waitFor(() => expect(getDiagnosticsMock).toHaveBeenCalledTimes(2));
  });

  it("shows a retry path when the query fails, and recovers", async () => {
    getDiagnosticsMock.mockRejectedValueOnce(new Error("ipc down"));
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);

    expect(await screen.findByText(/Couldn't load diagnostics/i)).toBeTruthy();

    getDiagnosticsMock.mockResolvedValue(makeResult([]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No lifecycle events yet/i)).toBeTruthy();
  });

  it("degrades to the empty state when the bridge lacks getDiagnostics", () => {
    (window as unknown as { electron: unknown }).electron = { devPreview: {} };
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="running" />);

    expect(screen.getByText(/No lifecycle events yet/i)).toBeTruthy();
  });

  it("renders crash-loop and proxy-fallback summary rows when present", async () => {
    const result = makeResult([{ type: "crash-loop-stopped", at: 1000, seq: 0, generation: 3 }], {
      crashLoop: { count: 6, stopped: true, backoffPending: false },
    });
    result.proxy = { port: 51234, usedPortFallback: true };
    getDiagnosticsMock.mockResolvedValue(result);
    render(<DiagnosticsPanel paneId="panel-1" projectId="project-1" status="stopped" />);

    expect(await screen.findByText("Crash loop")).toBeTruthy();
    expect(screen.getByText("stopped auto-restart")).toBeTruthy();
    expect(screen.getByText(/fallback — fixed port was taken/i)).toBeTruthy();
  });
});

describe("describeDiagnosticEvent", () => {
  const base = { at: 0, seq: 0, generation: 1 };

  it("gives every event type a non-empty label", () => {
    const events: DevPreviewDiagnosticEvent[] = [
      { ...base, type: "ensure-requested", configChanged: true },
      { ...base, type: "config-changed", changed: ["cwd", "env"] },
      { ...base, type: "command-invalid", message: "bad" },
      { ...base, type: "port-allocated", port: 3000 },
      { ...base, type: "port-conflict", port: 3000 },
      { ...base, type: "spawned", terminalId: "t", port: 3000 },
      { ...base, type: "spawn-failed", message: "nope" },
      { ...base, type: "install-started", command: "npm install" },
      { ...base, type: "install-completed" },
      { ...base, type: "install-failed", message: "exit 1" },
      { ...base, type: "command-submitted", via: "shell-args" },
      { ...base, type: "command-submitted", via: "pty-write" },
      { ...base, type: "first-output" },
      { ...base, type: "url-detected", url: "http://localhost:1" },
      { ...base, type: "candidate-url-chosen", url: "http://localhost:1", source: "predicted" },
      { ...base, type: "candidate-url-chosen", url: "http://localhost:1", source: "output" },
      { ...base, type: "marker-recognized", marker: "ready" },
      { ...base, type: "marker-recognized", marker: "compile" },
      {
        ...base,
        type: "readiness-http-attempt",
        url: "http://localhost:1",
        outcome: "reachable",
        status: 404,
        attempt: 1,
        elapsedMs: 12,
        remainingMs: 29000,
      },
      {
        ...base,
        type: "readiness-http-attempt",
        url: "http://localhost:1",
        outcome: "retry",
        cause: "connection-error",
        attempt: 3,
        elapsedMs: 5,
        remainingMs: 21000,
      },
      {
        ...base,
        type: "readiness-http-attempt",
        url: "http://localhost:1",
        outcome: "server-error",
        status: 500,
        attempt: 2,
        elapsedMs: 40,
        remainingMs: 25000,
      },
      { ...base, type: "readiness-probe-succeeded", url: "http://localhost:1" },
      { ...base, type: "readiness-probe-timed-out", url: "http://localhost:1", timeoutMs: 30000 },
      { ...base, type: "readiness-probe-failed", message: "boom" },
      { ...base, type: "compile-started" },
      { ...base, type: "compile-cleared", reason: "silence" },
      { ...base, type: "compile-cleared", reason: "ready-marker" },
      { ...base, type: "output-error", errorType: "oom", message: "heap" },
      { ...base, type: "restart-requested", mode: "clear-cache" },
      { ...base, type: "stop-requested", context: "project-hibernated" },
      { ...base, type: "terminal-exited", exitCode: 1, signal: 9 },
      { ...base, type: "crash-loop-backoff", attempt: 2, delayMs: 500 },
      { ...base, type: "crash-loop-stopped" },
      { ...base, type: "manifest-restored" },
      { ...base, type: "proxy-502", cause: "not-running" },
      { ...base, type: "proxy-ws-failed", cause: "upstream-refused", code: "ECONNREFUSED" },
    ];

    for (const event of events) {
      const { label } = describeDiagnosticEvent(event);
      expect(label.length, `label for ${event.type}`).toBeGreaterThan(0);
    }
  });

  // #12299: the silence timer only knows compile lines stopped arriving, so it
  // must not claim the compile finished.
  it("only claims a compile finished when a ready marker was observed", () => {
    expect(
      describeDiagnosticEvent({ ...base, type: "compile-cleared", reason: "ready-marker" }).label
    ).toBe("Compile finished");
    expect(
      describeDiagnosticEvent({ ...base, type: "compile-cleared", reason: "silence" }).label
    ).not.toMatch(/finished/i);
  });

  it("reports a 4xx attempt as a server that responded", () => {
    const { label, detail } = describeDiagnosticEvent({
      ...base,
      type: "readiness-http-attempt",
      url: "http://localhost:1",
      outcome: "reachable",
      status: 404,
      attempt: 1,
      elapsedMs: 12,
      remainingMs: 29000,
    });
    expect(label).toBe("Server responded");
    expect(detail).toContain("HTTP 404");
  });

  it("names the retry cause when no status came back", () => {
    const { label, detail } = describeDiagnosticEvent({
      ...base,
      type: "readiness-http-attempt",
      url: "http://localhost:1",
      outcome: "retry",
      cause: "request-timeout",
      attempt: 4,
      elapsedMs: 5000,
      remainingMs: 10000,
    });
    expect(label).toBe("No response");
    expect(detail).toContain("request timed out");
  });

  it("names the restart tier in the label", () => {
    expect(
      describeDiagnosticEvent({ ...base, type: "restart-requested", mode: "reinstall" }).label
    ).toContain("reinstall");
  });
});

describe("describeUpstream", () => {
  it("describes each resolution kind", () => {
    expect(describeUpstream({ kind: "ok", port: 8443, isHttps: true })).toBe(
      "localhost:8443 (https)"
    );
    expect(describeUpstream({ kind: "not-running", status: "restored-stopped" })).toContain(
      "restored-stopped"
    );
    expect(describeUpstream({ kind: "unknown-subdomain" })).toContain("not registered");
  });
});
