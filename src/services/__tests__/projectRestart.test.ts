import { beforeEach, describe, expect, it, vi } from "vitest";

interface Notice {
  type: string;
  title: string;
  message: string;
  actions?: Array<{ label: string; onClick: () => void }>;
}

const mocks = vi.hoisted(() => ({
  switchProject: vi.fn(),
  sleepProject: vi.fn(),
  storeSwitchProject: vi.fn(),
  clearSwitching: vi.fn(),
  setState: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  restoreViewState: vi.fn(),
  notify: vi.fn<(notice: Notice) => void>(),
  dispatch: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/clients/projectClient", () => ({
  projectClient: { switch: (...args: unknown[]) => mocks.switchProject(...args) },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", name: "One" }],
      sleepProject: mocks.sleepProject,
      switchProject: mocks.storeSwitchProject,
      clearSwitching: mocks.clearSwitching,
    }),
    setState: mocks.setState,
  },
  claimDroppedViewRestore: mocks.claim,
  releaseDroppedViewRestore: mocks.release,
  getProjectOpenErrorMessage: (error: unknown) => String(error),
}));
vi.mock("@/utils/stateHydration/restoreViewState", () => ({
  restoreViewState: mocks.restoreViewState,
}));
vi.mock("@/lib/notify", () => ({ notify: mocks.notify }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: mocks.dispatch } }));
vi.mock("@/utils/errorContext", () => ({ logErrorWithContext: vi.fn() }));

import { restartProject } from "../projectRestart";

function lastNotice(): Notice {
  const notice = mocks.notify.mock.calls.at(-1)?.[0];
  if (!notice) throw new Error("nothing was notified");
  return notice;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.sleepProject.mockImplementation(async () => {
    mocks.calls.push("sleep");
    return {};
  });
  mocks.claim.mockImplementation(() => {
    mocks.calls.push("claim");
    return true;
  });
  mocks.switchProject.mockImplementation(async () => {
    mocks.calls.push("switch");
    return { outcome: "switched", project: { id: "p1" } };
  });
  mocks.restoreViewState.mockImplementation(async () => {
    mocks.calls.push("restore");
  });
});

describe("restartProject", () => {
  it("sleeps, reopens in this window without an outgoing snapshot, then restores", async () => {
    await expect(restartProject("p1")).resolves.toBe("restarted");
    expect(mocks.calls).toEqual(["sleep", "claim", "switch", "restore"]);
    // An outgoing snapshot of the emptied panel store would overwrite the
    // layout the sleep just saved.
    expect(mocks.switchProject).toHaveBeenCalledWith("p1", undefined);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.clearSwitching).toHaveBeenCalledTimes(1);
  });

  it("leaves the project open and offers a retry when the sleep fails", async () => {
    mocks.sleepProject.mockRejectedValue(new Error("host busy"));
    await expect(restartProject("p1")).resolves.toBe("sleep-failed");
    expect(mocks.switchProject).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    const notice = lastNotice();
    expect(notice.type).toBe("error");
    expect(notice.message).toContain("still open in this window");
    expect(notice.message).toContain("host busy");
    notice.actions![0]!.onClick();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "project.restart",
      { projectId: "p1" },
      { source: "user" }
    );
  });

  it("says the project is asleep and reopens through the normal switch when the reopen fails", async () => {
    mocks.switchProject.mockRejectedValue(new Error("Workspace host failed to start."));
    await expect(restartProject("p1")).resolves.toBe("reopen-failed");
    expect(mocks.restoreViewState).not.toHaveBeenCalled();
    // Handed back so the next reopen from the picker restores the layout.
    expect(mocks.release).toHaveBeenCalledWith("p1");
    const notice = lastNotice();
    expect(notice.title).toBe("Couldn't reopen project");
    expect(notice.message).toContain("was put to sleep");
    expect(notice.message).toContain("Workspace host failed to start.");
    notice.actions![0]!.onClick();
    expect(mocks.storeSwitchProject).toHaveBeenCalledWith("p1");
    // A retry never repeats the destructive half.
    expect(mocks.sleepProject).toHaveBeenCalledTimes(1);
    expect(mocks.clearSwitching).toHaveBeenCalledTimes(1);
  });

  it("doesn't restore here when another window took the reopen", async () => {
    mocks.switchProject.mockResolvedValue({
      outcome: "focused-elsewhere",
      project: { id: "p1" },
      targetWindowId: 2,
    });
    await expect(restartProject("p1")).resolves.toBe("reopened-elsewhere");
    expect(mocks.restoreViewState).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("p1");
    expect(lastNotice().type).toBe("info");
  });

  it("stays quiet when a newer navigation superseded the reopen", async () => {
    mocks.switchProject.mockResolvedValue({ outcome: "superseded", project: { id: "p1" } });
    await expect(restartProject("p1")).resolves.toBe("reopened-elsewhere");
    expect(mocks.restoreViewState).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("reports a restore failure after the project reopened", async () => {
    mocks.restoreViewState.mockRejectedValue(new Error("hydrate failed"));
    await expect(restartProject("p1")).resolves.toBe("restore-failed");
    const notice = lastNotice();
    expect(notice.title).toBe("Couldn't restore project");
    expect(notice.message).toContain("reopened");
    expect(mocks.clearSwitching).toHaveBeenCalledTimes(1);
  });
});
