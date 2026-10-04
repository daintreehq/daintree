// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ProcessInventorySnapshot, ProcessInventoryTerminal } from "@shared/types/processes";

vi.mock("@/clients/processesClient", () => ({
  processesClient: { getSnapshot: vi.fn() },
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
const mockKill = vi.mocked(terminalClient.kill);
const mockStop = vi.fn();
const mockGetAllSessions = vi.fn();

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
    plugins: [],
    complete: true,
    samplesAvailable: true,
    sampledAt: Date.now(),
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
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { devPreview: { getAllSessions: mockGetAllSessions, stop: mockStop } },
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
});
