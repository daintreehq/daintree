// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ProcessInventoryClosedProcess,
  ProcessInventorySnapshot,
  ProcessInventoryTerminal,
} from "@shared/types/processes";

vi.mock("@/clients/processesClient", () => ({
  processesClient: { getSnapshot: vi.fn(), killClosedTerminalProcesses: vi.fn() },
}));

vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { kill: vi.fn() },
}));

import { processesClient } from "@/clients/processesClient";
import { terminalClient } from "@/clients/terminalClient";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessesDialog } from "../ProcessesDialog";

const mockGetSnapshot = vi.mocked(processesClient.getSnapshot);
const mockKillClosed = vi.mocked(processesClient.killClosedTerminalProcesses);
const mockKill = vi.mocked(terminalClient.kill);
const mockStop = vi.fn();
const mockGetAllSessions = vi.fn();
const mockGetInfo = vi.fn();

beforeAll(async () => {
  await primeRadix();
});

function terminal(
  id: string,
  extra: Partial<ProcessInventoryTerminal> = {}
): ProcessInventoryTerminal {
  return {
    id,
    projectId: "p1",
    projectName: "Cedar",
    cwd: "/",
    isAssistantTerminal: false,
    spawnedAt: 1,
    isTrashed: false,
    rootPid: 100,
    sample: {
      cpuPercent: 4,
      memoryKb: 300 * 1024,
      processCount: 3,
      members: [{ pid: 100, comm: "node", cpuPercent: 4, memoryKb: 300 * 1024 }],
    },
    ...extra,
  };
}

function snapshot(extra: Partial<ProcessInventorySnapshot> = {}): ProcessInventorySnapshot {
  return {
    terminals: [],
    closedTerminalProcesses: [],
    cleanup: null,
    plugins: [],
    complete: true,
    samplesAvailable: true,
    sampledAt: Date.now(),
    ...extra,
  };
}

function closed(
  pid: number,
  extra: Partial<ProcessInventoryClosedProcess> = {}
): ProcessInventoryClosedProcess {
  return {
    pid,
    startTime: `start-${pid}`,
    comm: "node",
    memoryKb: 512 * 1024,
    cpuPercent: 0,
    origin: { kind: "terminal", id: "t-old", projectId: "p1", title: "npm run dev", spawnedAt: 5 },
    closedAt: Date.now() - 120_000,
    projectName: "Cedar",
    ...extra,
  };
}

async function renderOpen() {
  await act(async () => {
    render(
      <TooltipProvider>
        <ProcessesDialog isOpen onClose={() => {}} />
      </TooltipProvider>
    );
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllSessions.mockResolvedValue([]);
  mockStop.mockResolvedValue(undefined);
  mockKill.mockResolvedValue(undefined);
  mockGetInfo.mockResolvedValue({ id: "a", spawnedAt: 1, hasPty: true });
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      devPreview: { getAllSessions: mockGetAllSessions, stop: mockStop },
      terminal: { getInfo: mockGetInfo },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProcessesDialog (#13175)", () => {
  it("groups terminals by project and reads memory as approximate", async () => {
    mockGetSnapshot.mockResolvedValue(
      snapshot({
        terminals: [
          terminal("a", { title: "npm run dev" }),
          terminal("b", { projectId: "p2", projectName: "Birch", title: "claude" }),
        ],
        plugins: [
          {
            source: "plugin-process",
            id: "x",
            pluginId: "acme",
            label: "node",
            pid: 700,
            spawnedAt: 1,
            sample: null,
          },
        ],
      })
    );

    await renderOpen();

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Birch1 terminal", "Cedar1 terminal", "Plugins"]);
    expect(screen.getAllByText("~300 MB")).toHaveLength(2);
    expect(screen.getByText("Not sampled")).toBeTruthy();
    // Plugin rows are list-only.
    const pluginRow = screen.getByTestId("plugin-process-row");
    expect(pluginRow.querySelector("button")).toBeNull();
  });

  it("kills a terminal only after the confirm, and drops its row", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    expect(mockKill).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Kill 'shell'?");
    expect(confirm.textContent).toContain("in Cedar and the 2 processes running in it");

    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    });

    expect(mockKill).toHaveBeenCalledWith("a");
    // Still listed by the census, but hidden until it stops being listed.
    expect(screen.queryByTestId("process-row")).toBeNull();
  });

  it("shows a pane that restarted on exit again, as the new process", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    });
    expect(screen.queryByTestId("process-row")).toBeNull();

    mockGetSnapshot.mockResolvedValue(
      snapshot({ terminals: [terminal("a", { title: "shell", spawnedAt: 99 })] })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(screen.getAllByTestId("process-row")).toHaveLength(1);
  });

  it("refuses to kill a pane that restarted while the confirm was open", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    await screen.findByRole("alertdialog");
    mockGetInfo.mockResolvedValue({ id: "a", spawnedAt: 50, hasPty: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    });

    expect(mockKill).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("restarted after you chose it");
  });

  it("stops a dev preview whose PTY already left, so its recovery is cancelled", async () => {
    mockGetSnapshot.mockResolvedValue(
      snapshot({ terminals: [terminal("dev-term", { kind: "dev-preview", title: "web" })] })
    );
    mockGetAllSessions.mockResolvedValue([
      { terminalId: "dev-term", projectId: "p1", panelId: "panel-7" },
    ]);
    mockGetInfo.mockRejectedValue(new Error("Terminal dev-term not found"));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'web' in Cedar" }));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop dev server" }));
    });

    expect(mockStop).toHaveBeenCalledWith({ projectId: "p1", panelId: "panel-7" });
  });

  it("opens the confirm for the latest Kill press, not a slower earlier one", async () => {
    mockGetSnapshot.mockResolvedValue(
      snapshot({
        terminals: [terminal("a", { title: "first" }), terminal("b", { title: "second" })],
      })
    );
    await renderOpen();
    let releaseFirst!: (value: unknown[]) => void;
    mockGetAllSessions.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve))
    );

    fireEvent.click(screen.getByRole("button", { name: "Kill 'first' in Cedar" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill 'second' in Cedar" }));
    const confirm = await screen.findByRole("alertdialog");
    await act(async () => {
      releaseFirst([]);
    });

    expect(confirm.textContent).toContain("Kill 'second'?");
    expect(screen.getByRole("alertdialog").textContent).toContain("Kill 'second'?");
  });

  it("offers no kill when the dev preview sessions can't be read", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "web" })] }));
    await renderOpen();
    mockGetAllSessions.mockRejectedValue(new Error("ipc down"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill 'web' in Cedar" }));
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("nothing was killed");
  });

  it("says a trashed terminal's pane goes for good", async () => {
    mockGetSnapshot.mockResolvedValue(
      snapshot({ terminals: [terminal("a", { title: "shell", isTrashed: true })] })
    );
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    const confirm = await screen.findByRole("alertdialog");

    expect(confirm.textContent).toContain("can't be restored");
  });

  it("drops a pending confirm when the dialog closes", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      ({ rerender } = render(
        <TooltipProvider>
          <ProcessesDialog isOpen onClose={() => {}} />
        </TooltipProvider>
      ));
    });
    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    await screen.findByRole("alertdialog");

    await act(async () => {
      rerender(
        <TooltipProvider>
          <ProcessesDialog isOpen={false} onClose={() => {}} />
        </TooltipProvider>
      );
    });
    await act(async () => {
      rerender(
        <TooltipProvider>
          <ProcessesDialog isOpen onClose={() => {}} />
        </TooltipProvider>
      );
    });

    // The closed confirm finishes its exit animation, then stays closed.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getAllByTestId("process-row")).toHaveLength(1);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("cancelling the confirm kills nothing", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(mockKill).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("process-row")).toHaveLength(1);
  });

  it("stops a dev preview through its session instead of killing the PTY", async () => {
    mockGetSnapshot.mockResolvedValue(
      snapshot({ terminals: [terminal("dev-term", { kind: "dev-preview", title: "web" })] })
    );
    mockGetAllSessions.mockResolvedValue([
      { terminalId: "dev-term", projectId: "p1", panelId: "panel-7" },
    ]);
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'web' in Cedar" }));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop dev server" }));
    });

    expect(mockStop).toHaveBeenCalledWith({ projectId: "p1", panelId: "panel-7" });
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("shows a failed kill inline and keeps the row", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ terminals: [terminal("a", { title: "shell" })] }));
    mockKill.mockRejectedValue(new Error("no such terminal"));
    await renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "Kill 'shell' in Cedar" }));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("Couldn't kill 'shell'");
    expect(screen.getAllByTestId("process-row")).toHaveLength(1);
  });

  it("says when a host didn't answer instead of showing a short list as complete", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot({ complete: false }));
    await renderOpen();

    expect(screen.getByText(/some terminals may be missing/)).toBeTruthy();
  });

  it("keeps the last reading when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetSnapshot.mockResolvedValueOnce(
      snapshot({ terminals: [terminal("a", { title: "shell" })] })
    );
    await renderOpen();

    mockGetSnapshot.mockRejectedValue(new Error("ipc down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(screen.getByText(/Showing the last reading/)).toBeTruthy();
    expect(screen.getAllByTestId("process-row")).toHaveLength(1);
  });

  it("stops polling once closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetSnapshot.mockResolvedValue(snapshot());
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      ({ rerender } = render(
        <TooltipProvider>
          <ProcessesDialog isOpen onClose={() => {}} />
        </TooltipProvider>
      ));
    });
    const calls = mockGetSnapshot.mock.calls.length;

    await act(async () => {
      rerender(
        <TooltipProvider>
          <ProcessesDialog isOpen={false} onClose={() => {}} />
        </TooltipProvider>
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(mockGetSnapshot.mock.calls.length).toBe(calls);
  });

  describe("processes from closed terminals (#13174)", () => {
    it("lists them by the terminal that started them, with count and approximate memory", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({
          closedTerminalProcesses: [closed(201), closed(202, { comm: "esbuild" })],
        })
      );
      await renderOpen();

      const row = screen.getByTestId("closed-process-row");
      expect(row.textContent).toContain("npm run dev");
      expect(row.textContent).toContain("Cedar");
      expect(row.textContent).toContain("Closed 2m ago");
      expect(row.textContent).toContain("node, esbuild");
      expect(row.textContent).toContain("2 processes");
      expect(row.textContent).toContain("~1.0 GB");
      expect(screen.queryByText("No terminals or plugin processes are running.")).toBeNull();
      // Observations only — never a verdict about the process.
      const dialog = screen.getByTestId("processes-dialog");
      expect(dialog.textContent).not.toMatch(/leak|orphan|unused/i);
    });

    it("kills only after the confirm, naming the recorded identities", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({ closedTerminalProcesses: [closed(201), closed(202)] })
      );
      mockKillClosed.mockResolvedValue({ ended: 2, stillRunning: 0, unchecked: 0, notTracked: 0 });
      await renderOpen();

      fireEvent.click(screen.getByRole("button", { name: "Kill 2 processes from 'npm run dev'" }));
      expect(mockKillClosed).not.toHaveBeenCalled();

      const confirm = await screen.findByRole("alertdialog");
      expect(confirm.textContent).toContain("Kill 2 processes from 'npm run dev'?");
      expect(confirm.textContent).toContain("in Cedar");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Kill 2 processes" }));
      });

      expect(mockKillClosed).toHaveBeenCalledWith([
        { pid: 201, startTime: "start-201" },
        { pid: 202, startTime: "start-202" },
      ]);
      await waitFor(() => expect(screen.queryByTestId("closed-process-row")).toBeNull());
    });

    it("says what is still running or couldn't be checked after a kill, and keeps the row", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({ closedTerminalProcesses: [closed(201), closed(202), closed(203)] })
      );
      mockKillClosed.mockResolvedValue({ ended: 1, stillRunning: 1, unchecked: 1, notTracked: 0 });
      await renderOpen();

      fireEvent.click(screen.getByRole("button", { name: "Kill 3 processes from 'npm run dev'" }));
      await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Kill 3 processes" }));
      });

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Ended 1 of 3 processes.");
      expect(alert.textContent).toContain("1 process is still running.");
      expect(alert.textContent).toContain("Couldn't check 1 process");
      expect(screen.getByTestId("closed-process-row")).toBeTruthy();
    });

    it("cancelling the confirm kills nothing", async () => {
      mockGetSnapshot.mockResolvedValue(snapshot({ closedTerminalProcesses: [closed(201)] }));
      await renderOpen();

      fireEvent.click(screen.getByRole("button", { name: "Kill 1 process from 'npm run dev'" }));
      await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });

      expect(mockKillClosed).not.toHaveBeenCalled();
    });

    it("says the census failed rather than presenting the list as current", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({ samplesAvailable: false, closedTerminalProcesses: [closed(201)] })
      );
      await renderOpen();

      expect(screen.getByText(/can't currently check what's still running/)).toBeTruthy();
    });

    it("reports what launch cleanup did and couldn't check", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({
          cleanup: { found: 3, ended: 3, stillRunning: 0, unchecked: 2, lastAt: Date.now() },
        })
      );
      await renderOpen();

      const dialog = screen.getByTestId("processes-dialog");
      expect(dialog.textContent).toContain(
        "Ended 3 processes left running by an earlier session."
      );
      expect(dialog.textContent).toContain(
        "Couldn't check 2 processes recorded by an earlier session."
      );
    });
  });
});
