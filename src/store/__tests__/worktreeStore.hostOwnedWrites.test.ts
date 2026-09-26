import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appSetStateMock, logErrorWithContextMock } = vi.hoisted(() => ({
  appSetStateMock: vi.fn(),
  logErrorWithContextMock: vi.fn(),
}));

const panelState = {
  panelsById: {},
  panelIds: [] as string[],
  tabGroups: new Map(),
  activeDockTerminalId: null,
  focusedId: null,
  mruList: [] as string[],
  maximizedId: null,
  maximizeTarget: null,
  preMaximizeLayout: null,
  recordMru: vi.fn(),
  setFocused: vi.fn(),
};

vi.mock("@/clients", () => ({ appClient: { setState: appSetStateMock } }));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { applyRendererPolicy: vi.fn(), wake: vi.fn(() => true) },
}));
vi.mock("@/services/terminal/worktreeRevealCoordinator", () => ({
  replaceWorktreeRevealObligations: vi.fn(),
  clearWorktreeRevealObligations: vi.fn(),
}));
vi.mock("@/utils/errorContext", () => ({ logErrorWithContext: logErrorWithContextMock }));
vi.mock("@/store/focusStore", () => ({
  useFocusStore: {
    getState: () => ({
      isFocusMode: false,
      gestureSidebarHidden: false,
      gestureAssistantHidden: false,
      clearSidebarGesture: () => {},
    }),
  },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => panelState,
    setState: (patch: Record<string, unknown>) => Object.assign(panelState, patch),
    subscribe: () => () => {},
  },
}));

import { persistMruList, useWorktreeSelectionStore } from "../worktreeStore";
import {
  _resetHostOwnedWritesForTesting,
  setHostOwnedWriteFlushBarrier,
} from "../persistence/hostOwnedWrites";
import {
  _resetTerminalInputGateForTesting,
  setHostInputBlock,
  setLeaseInputBlock,
} from "@/services/terminal/inputGate";

const appError = (code: string, message: string) => new Error(`[AppError|${code}] ${message}`);

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function activeWrites(): unknown[] {
  return appSetStateMock.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => "activeWorktreeId" in payload)
    .map((payload) => payload.activeWorktreeId);
}

function mruWrites(): unknown[] {
  return appSetStateMock.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => "mruList" in payload)
    .map((payload) => payload.mruList);
}

let unique = 0;
/** Ids fresh per test, so the store's module-level "already saved" memory never dedupes them. */
const id = (name: string) => `${name}-${++unique}`;

beforeEach(() => {
  vi.clearAllMocks();
  appSetStateMock.mockResolvedValue(undefined);
  _resetTerminalInputGateForTesting();
  _resetHostOwnedWritesForTesting();
  useWorktreeSelectionStore.getState().reset();
});

afterEach(() => {
  _resetHostOwnedWritesForTesting();
  _resetTerminalInputGateForTesting();
});

describe("worktreeStore host-owned saves", () => {
  it("a local view saves and reports a real failure as before", async () => {
    const wt = id("wt");
    appSetStateMock.mockRejectedValueOnce(new Error("EACCES"));
    useWorktreeSelectionStore.getState().setActiveWorktree(wt);
    await drain();
    expect(activeWrites()).toEqual([wt]);
    expect(logErrorWithContextMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "persist_active_worktree", errorType: "filesystem" })
    );
  });

  it("makes no active-worktree or MRU save while another screen drives the project", async () => {
    setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "laptop", projectId: "proj-1" });
    useWorktreeSelectionStore.getState().setActiveWorktree(id("wt"));
    persistMruList([id("mru")]);
    await drain();
    expect(appSetStateMock).not.toHaveBeenCalled();
    expect(logErrorWithContextMock).not.toHaveBeenCalled();
  });

  it("doesn't log a DRIVEN_ELSEWHERE refusal as an error", async () => {
    appSetStateMock.mockRejectedValue(
      appError("DRIVEN_ELSEWHERE", "app:set-state changes proj-1, which another window drives")
    );
    useWorktreeSelectionStore.getState().setActiveWorktree(id("wt"));
    persistMruList([id("mru")]);
    await drain();
    expect(appSetStateMock).toHaveBeenCalledTimes(2);
    expect(logErrorWithContextMock).not.toHaveBeenCalled();
  });

  it("flushes the latest save lost to a reconnect once the link is back", async () => {
    let releaseBarrier!: () => void;
    setHostOwnedWriteFlushBarrier(() => new Promise<void>((r) => (releaseBarrier = r)));
    const [first, second] = [id("wt"), id("wt")];
    const list = [id("mru")];
    appSetStateMock.mockRejectedValue(
      appError("HOST_DISCONNECTED", "Link to host closed: host e2e-host is connecting")
    );
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    // The first write went out as the link dropped; the second waits for it.
    setHostInputBlock(null);
    useWorktreeSelectionStore.getState().setActiveWorktree(first);
    persistMruList(list);
    await drain();
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    useWorktreeSelectionStore.getState().setActiveWorktree(second);
    await drain();
    expect(logErrorWithContextMock).not.toHaveBeenCalled();
    expect(activeWrites()).toEqual([first]);

    appSetStateMock.mockResolvedValue(undefined);
    setHostInputBlock(null);
    await drain();
    // Not before the lease is re-read and a fresh session's rehydrate is done.
    expect(activeWrites()).toEqual([first]);
    releaseBarrier();
    await drain();
    expect(activeWrites()).toEqual([first, second]);
    expect(mruWrites()).toEqual([list, list]);
  });

  it("drops a save held through a reconnect when someone else took the project over", async () => {
    const wt = id("wt");
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    useWorktreeSelectionStore.getState().setActiveWorktree(wt);
    persistMruList([id("mru")]);
    await drain();
    // The lease refresh after reconnecting learns of the takeover.
    setHostOwnedWriteFlushBarrier(async () =>
      setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "laptop", projectId: "proj-1" })
    );
    setHostInputBlock(null);
    await drain();
    expect(appSetStateMock).not.toHaveBeenCalled();
  });

  it("a switch back to the saved worktree cancels a held switch away from it", async () => {
    const [home, away] = [id("wt"), id("wt")];
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    useWorktreeSelectionStore.getState().setActiveWorktree(away);
    await drain();
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    setHostInputBlock(null);
    await drain();
    expect(activeWrites()).toEqual([home]);
  });

  it("returning to the saved worktree while a different pick is in flight saves it again, and the lost pick never replays", async () => {
    const [home, away] = [id("wt"), id("wt")];
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    let loseAway!: (error: Error) => void;
    appSetStateMock.mockImplementationOnce(() => new Promise((_, reject) => (loseAway = reject)));
    useWorktreeSelectionStore.getState().setActiveWorktree(away);
    await drain();
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    loseAway(appError("HOST_DISCONNECTED", "Link to host closed"));
    await drain();
    setHostInputBlock(null);
    await drain();
    expect(activeWrites()).toEqual([home, away, home]);
  });

  it("stops trusting what it last saved once another screen drove the project", async () => {
    const [home, driversPick] = [id("wt"), id("wt")];
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "laptop", projectId: "proj-1" });
    // Taking over reads the driver's pick back without saving it (the rehydrate).
    useWorktreeSelectionStore.getState().setActiveWorktree(driversPick, { persist: false });
    setLeaseInputBlock(null);
    useWorktreeSelectionStore.getState().setActiveWorktree(home);
    await drain();
    expect(activeWrites()).toEqual([home, home]);
  });

  it("repeating a pick that is still in flight keeps it eligible to be held if the link loses it", async () => {
    const wt = id("wt");
    let lose!: (error: Error) => void;
    appSetStateMock.mockImplementationOnce(() => new Promise((_, reject) => (lose = reject)));
    useWorktreeSelectionStore.getState().setActiveWorktree(wt);
    await drain();
    useWorktreeSelectionStore.getState().setActiveWorktree(wt, { persist: true });
    await drain();
    setHostInputBlock({ kind: "disconnected", hostName: "e2e-host" });
    lose(appError("HOST_DISCONNECTED", "Link to host closed"));
    await drain();
    setHostInputBlock(null);
    await drain();
    expect(activeWrites()).toEqual([wt, wt]);
  });
});
