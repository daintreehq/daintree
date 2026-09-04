// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";

const getDiagnosticsSnapshot = vi.fn();
vi.mock("@/clients/pluginClient", () => ({
  pluginClient: { getDiagnosticsSnapshot: (...args: unknown[]) => getDiagnosticsSnapshot(...args) },
}));

async function load() {
  return await import("../PluginLogsSection");
}

function entry(pluginId: string, logLines: Array<{ ts: number; level: string; message: string }>) {
  return { pluginId, displayName: pluginId, version: "1.0.0", logLines };
}

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePluginLogs", () => {
  it("reads only the named plugin's buffer", async () => {
    getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        entry("other.plugin", [{ ts: 1, level: "info", message: "someone else's line" }]),
        entry("acme.demo", [{ ts: 2, level: "warn", message: "mine" }]),
      ],
    });
    const { usePluginLogs } = await load();
    const { result } = renderHook(() => usePluginLogs("acme.demo"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lines).toEqual([{ ts: 2, level: "warn", message: "mine" }]);
  });

  it("finds a project plugin, which runs under an instance key not its manifest id", async () => {
    getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        entry("project__project-1__acme.demo", [{ ts: 3, level: "info", message: "project line" }]),
      ],
    });
    const { usePluginLogs } = await load();
    const { result } = renderHook(() => usePluginLogs("acme.demo"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lines).toEqual([{ ts: 3, level: "info", message: "project line" }]);
  });

  it("distinguishes a plugin that is not running from one that logged nothing", async () => {
    getDiagnosticsSnapshot.mockResolvedValue({ plugins: [] });
    const { usePluginLogs } = await load();
    const notRunning = renderHook(() => usePluginLogs("acme.demo"));
    await waitFor(() => expect(notRunning.result.current.loading).toBe(false));
    expect(notRunning.result.current.lines).toBeNull();

    getDiagnosticsSnapshot.mockResolvedValue({ plugins: [entry("acme.demo", [])] });
    const ranQuietly = renderHook(() => usePluginLogs("acme.demo"));
    await waitFor(() => expect(ranQuietly.result.current.loading).toBe(false));
    expect(ranQuietly.result.current.lines).toEqual([]);
  });

  it("surfaces a read failure rather than reporting an empty buffer", async () => {
    getDiagnosticsSnapshot.mockRejectedValue(new Error("IPC gone"));
    const { usePluginLogs } = await load();
    const { result } = renderHook(() => usePluginLogs("acme.demo"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("IPC gone");
    expect(result.current.lines).toBeNull();
  });

  it("re-reads on refresh", async () => {
    getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [entry("acme.demo", [{ ts: 1, level: "info", message: "first" }])],
    });
    const { usePluginLogs } = await load();
    const { result } = renderHook(() => usePluginLogs("acme.demo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [entry("acme.demo", [{ ts: 2, level: "info", message: "second" }])],
    });
    act(() => result.current.refresh());

    await waitFor(() =>
      expect(result.current.lines).toEqual([{ ts: 2, level: "info", message: "second" }])
    );
    expect(getDiagnosticsSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("PluginLogsSection", () => {
  it("renders the lines it is given", async () => {
    const { PluginLogsSection } = await load();
    render(
      <PluginLogsSection
        lines={[{ ts: 1_700_000_000_000, level: "error", message: "activate failed" }]}
        loading={false}
        error={null}
        refresh={noop}
      />
    );
    expect(screen.getByText("activate failed")).toBeTruthy();
  });

  it("explains a missing buffer rather than showing it as empty", async () => {
    const { PluginLogsSection } = await load();
    render(<PluginLogsSection lines={null} loading={false} error={null} refresh={noop} />);
    expect(screen.getByText(/isn't running/)).toBeTruthy();
  });

  it("explains an emptied buffer, which a reload produces while the tab is open", async () => {
    const { PluginLogsSection } = await load();
    render(<PluginLogsSection lines={[]} loading={false} error={null} refresh={noop} />);
    expect(screen.getByText(/buffer is empty/)).toBeTruthy();
  });

  it("shows a read failure instead of an empty state", async () => {
    const { PluginLogsSection } = await load();
    render(<PluginLogsSection lines={null} loading={false} error="IPC gone" refresh={noop} />);
    expect(screen.getByText("IPC gone")).toBeTruthy();
    expect(screen.queryByText(/isn't running/)).toBeNull();
  });

  it("calls refresh and disables the control while a read is in flight", async () => {
    const refresh = vi.fn();
    const { PluginLogsSection } = await load();
    const { rerender } = render(
      <PluginLogsSection lines={[]} loading={false} error={null} refresh={refresh} />
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledOnce();

    rerender(<PluginLogsSection lines={[]} loading={true} error={null} refresh={refresh} />);
    expect(screen.getByRole("button", { name: /refresh/i }).hasAttribute("disabled")).toBe(true);
  });
});
