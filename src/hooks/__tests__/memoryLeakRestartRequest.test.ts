import { beforeEach, describe, expect, it, vi } from "vitest";

const restartTerminal = vi.fn(async () => {});
const panelsById: Record<string, unknown> = {};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById, restartTerminal }) },
}));

interface Notice {
  title: string;
  message: string;
  context: unknown;
}
const notify = vi.fn((_notice: Notice) => {});
vi.mock("@/lib/notify", () => ({ notify: (notice: Notice) => notify(notice) }));

const { handleMemoryLeakRestartRequest } = await import("../useMemoryLeakDetection");

function pane(overrides: Record<string, unknown> = {}) {
  return { id: "t1", kind: "terminal", title: "Claude", worktreeId: "wt-1", ...overrides };
}

describe("handleMemoryLeakRestartRequest", () => {
  beforeEach(() => {
    restartTerminal.mockClear();
    notify.mockClear();
    for (const key of Object.keys(panelsById)) delete panelsById[key];
  });

  it("restarts the pane the host named and says why", () => {
    panelsById.t1 = pane({ agentState: "working" });

    handleMemoryLeakRestartRequest({ terminalId: "t1", thresholdMb: 8192 });

    expect(restartTerminal).toHaveBeenCalledWith("t1");
    expect(notify).toHaveBeenCalledTimes(1);
    const notice = notify.mock.calls[0]![0];
    expect(notice.title).toContain("Claude");
    expect(notice.message).toContain((8192).toLocaleString());
    expect(notice.context).toEqual({ panelId: "t1", worktreeId: "wt-1" });
  });

  it("leaves a pane waiting for input alone", () => {
    panelsById.t1 = pane({ agentState: "waiting" });
    handleMemoryLeakRestartRequest({ terminalId: "t1", thresholdMb: 8192 });
    expect(restartTerminal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a pane locked against input alone", () => {
    panelsById.t1 = pane({ isInputLocked: true });
    handleMemoryLeakRestartRequest({ terminalId: "t1", thresholdMb: 8192 });
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a terminal this view doesn't hold", () => {
    handleMemoryLeakRestartRequest({ terminalId: "missing", thresholdMb: 8192 });
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("ignores a panel with no PTY", () => {
    panelsById.t1 = pane({ kind: "browser" });
    handleMemoryLeakRestartRequest({ terminalId: "t1", thresholdMb: 8192 });
    expect(restartTerminal).not.toHaveBeenCalled();
  });
});
