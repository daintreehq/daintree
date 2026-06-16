// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginMcpServersSection } from "../PluginMcpServersSection";
import type { McpServerContribution } from "@shared/types/plugin";
import type { PluginMcpServerInfo, PluginMcpStderrResult } from "@shared/types/ipc/pluginMcp";

const listMock = vi.hoisted(() => vi.fn());
const getStderrMock = vi.hoisted(() => vi.fn());
const restartMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  listMock.mockReset();
  getStderrMock.mockReset();
  restartMock.mockReset();
  listMock.mockResolvedValue([]);
  getStderrMock.mockResolvedValue({ pluginId: "", serverId: "", lines: [], totalLines: 0 });
  restartMock.mockResolvedValue(undefined);
  (globalThis as unknown as { window: Window }).window.electron = {
    pluginMcp: { list: listMock, getStderr: getStderrMock, restart: restartMock },
  } as unknown as Window["electron"];
});

afterEach(() => {
  cleanup();
});

const PLUGIN_ID = "acme.demo";

function declared(...ids: Array<[string, string]>): McpServerContribution[] {
  return ids.map(([id, name]) => ({ id, name, command: "node" }));
}

function info(overrides: Partial<PluginMcpServerInfo> & { serverId: string }): PluginMcpServerInfo {
  return {
    pluginId: PLUGIN_ID,
    name: overrides.serverId,
    status: "ready",
    pid: 1234,
    lastError: null,
    stderrLineCount: 0,
    ...overrides,
  };
}

function renderSection(servers: McpServerContribution[]) {
  return render(<PluginMcpServersSection pluginId={PLUGIN_ID} declared={servers} />);
}

describe("PluginMcpServersSection (issue #10584)", () => {
  it("shows a declared server as Not started before it has spawned", async () => {
    listMock.mockResolvedValue([]);
    renderSection(declared(["srv", "Demo Server"]));
    expect(await screen.findByText("Demo Server")).toBeTruthy();
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start server/ })).toBeTruthy();
  });

  it("reflects the live status and pid for a running server", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", pid: 4242 })]);
    renderSection(declared(["srv", "Demo Server"]));
    expect(await screen.findByText(/Running/)).toBeTruthy();
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart server/ })).toBeTruthy();
  });

  it("surfaces the crash error for a crashed server", async () => {
    listMock.mockResolvedValue([
      info({ serverId: "srv", status: "crashed", pid: null, lastError: "ENOENT: node not found" }),
    ]);
    renderSection(declared(["srv", "Demo Server"]));
    expect(await screen.findByText("ENOENT: node not found")).toBeTruthy();
    expect(screen.getByText("Crashed")).toBeTruthy();
  });

  it("only shows servers belonging to this plugin", async () => {
    listMock.mockResolvedValue([
      info({ serverId: "srv", status: "ready" }),
      {
        ...info({ serverId: "srv", status: "crashed" }),
        pluginId: "other.plugin",
        name: "Intruder",
      },
    ]);
    renderSection(declared(["srv", "Demo Server"]));
    expect(await screen.findByText("Demo Server")).toBeTruthy();
    expect(screen.queryByText("Intruder")).toBeNull();
    // The cross-plugin crashed state must not leak into our row's status.
    expect(screen.getByText(/Running/)).toBeTruthy();
    expect(screen.queryByText("Crashed")).toBeNull();
  });

  it("restarts a crashed server and disables the button while in flight", async () => {
    listMock.mockResolvedValue([
      info({ serverId: "srv", status: "crashed", pid: null, lastError: "boom" }),
    ]);
    let resolveRestart: () => void = () => {};
    restartMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRestart = resolve;
        })
    );
    renderSection(declared(["srv", "Demo Server"]));
    const button = (await screen.findByRole("button", {
      name: /Restart server/,
    })) as HTMLButtonElement;

    fireEvent.click(button);
    expect(restartMock).toHaveBeenCalledWith({ pluginId: PLUGIN_ID, serverId: "srv" });
    await waitFor(() => expect(button.disabled).toBe(true));

    // Once the respawn settles ready, the post-restart refresh re-polls and the
    // row flips to Running — proving refreshNow() ran, not just the finally block.
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", pid: 99 })]);
    resolveRestart();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(await screen.findByText(/Running/)).toBeTruthy();
    expect(screen.getByText(/pid 99/)).toBeTruthy();
  });

  it("shows a row error when restart throws", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "crashed", lastError: "boom" })]);
    restartMock.mockRejectedValue(new Error("plugin or server is not registered"));
    renderSection(declared(["srv", "Demo Server"]));
    fireEvent.click(await screen.findByRole("button", { name: /Restart server/ }));
    expect(await screen.findByText("plugin or server is not registered")).toBeTruthy();
  });

  it("does not fetch stderr until the output disclosure is expanded", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", stderrLineCount: 3 })]);
    const result: PluginMcpStderrResult = {
      pluginId: PLUGIN_ID,
      serverId: "srv",
      lines: ["line one", "line two", "line three"],
      totalLines: 3,
    };
    getStderrMock.mockResolvedValue(result);
    renderSection(declared(["srv", "Demo Server"]));

    const toggle = await screen.findByRole("button", { name: /View output/ });
    expect(getStderrMock).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(await screen.findByText(/line two/)).toBeTruthy();
    expect(getStderrMock).toHaveBeenCalledWith({ pluginId: PLUGIN_ID, serverId: "srv" });
  });

  it("shows an inline error when stderr fetch fails, not a perpetual loader", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", stderrLineCount: 5 })]);
    getStderrMock.mockRejectedValue(new Error("supervisor unavailable"));
    renderSection(declared(["srv", "Demo Server"]));
    fireEvent.click(await screen.findByRole("button", { name: /View output/ }));
    expect(await screen.findByText("supervisor unavailable")).toBeTruthy();
    expect(screen.queryByText(/Loading output/)).toBeNull();
  });

  it("notes truncation when the ring buffer dropped older lines", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", stderrLineCount: 2 })]);
    getStderrMock.mockResolvedValue({
      pluginId: PLUGIN_ID,
      serverId: "srv",
      lines: ["recent a", "recent b"],
      totalLines: 530,
    });
    renderSection(declared(["srv", "Demo Server"]));
    fireEvent.click(await screen.findByRole("button", { name: /View output/ }));
    expect(await screen.findByText(/Showing the most recent 2 of 530 lines/)).toBeTruthy();
  });

  it("does not offer an output disclosure when the server has no stderr", async () => {
    listMock.mockResolvedValue([info({ serverId: "srv", status: "ready", stderrLineCount: 0 })]);
    renderSection(declared(["srv", "Demo Server"]));
    await screen.findByText(/Running/);
    expect(screen.queryByRole("button", { name: /View output/ })).toBeNull();
  });

  it("shows a section error banner when the snapshot fetch fails", async () => {
    listMock.mockRejectedValue(new Error("IPC channel closed"));
    renderSection(declared(["srv", "Demo Server"]));
    expect(await screen.findByText("IPC channel closed")).toBeTruthy();
  });
});
