import { describe, it, expect, vi, beforeEach } from "vitest";

type StoredProject = { id: string; name: string; path: string; status?: string };

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById: vi.fn<(projectId: string) => StoredProject | null>(),
  clearCurrentProject: vi.fn<() => void>(),
  updateProjectStatus: vi.fn<(...args: unknown[]) => unknown>(),
}));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

type TeardownOptions = {
  preserveSession?: boolean;
  writeBackSessionIds?: boolean;
  beforeKill?: (snapshot: { terminals: unknown[]; degraded: boolean }) => boolean;
};
type TeardownResult = {
  confirmed: boolean;
  aborted: boolean;
  terminalsKilled: number;
  sessions: Array<{ id: string; agentSessionId: string | null }>;
};

/** What the helper's pre-kill snapshot hands a `beforeKill` guard. */
const killSnapshot = vi.hoisted(() => ({
  value: { terminals: [] as unknown[], degraded: false },
}));
const teardownMock = vi.hoisted(() => ({
  gracefulTeardownAndJournalProject:
    vi.fn<
      (
        scopeId: string,
        client: unknown,
        workspaceClient: unknown,
        options: TeardownOptions
      ) => Promise<TeardownResult>
    >(),
}));
vi.mock("../pty/projectSessionJournal.js", () => teardownMock);

const helpSessionServiceMock = vi.hoisted(() => ({
  revokeByProjectId: vi.fn<(projectId: string) => Promise<void>>(async () => {}),
}));
vi.mock("../HelpSessionService.js", () => ({ helpSessionService: helpSessionServiceMock }));

const hibernationMock = vi.hoisted(() => ({
  evictProjectRenderer:
    vi.fn<(projectId: string, options?: { protectMcpDispatch?: boolean }) => number>(),
}));
vi.mock("../HibernationService.js", () => ({ getHibernationService: () => hibernationMock }));

const persistenceMock = vi.hoisted(() => ({
  writeHibernatedMarker: vi.fn<(terminalId: string) => void>(),
}));
vi.mock("../pty/terminalSessionPersistence.js", () => persistenceMock);

const pluginLifecycleMock = vi.hoisted(() => ({
  notifyProjectPluginsClosed: vi.fn<(projectId: string) => void>(),
}));
vi.mock("../../window/projectPluginLifecycle.js", () => pluginLifecycleMock);

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));

vi.mock("../../utils/logger.js", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

const panelRecoveryMock = vi.hoisted(() => ({
  readPanelRecoveryHold: vi.fn<(projectId: string, provider: unknown) => Promise<string | null>>(),
}));
vi.mock("../panelRecoveryQuery.js", () => panelRecoveryMock);

import { CHANNELS } from "../../ipc/channels.js";
import { sleepProject, type SleepProjectOptions } from "../projectSleep.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  _resetDictationViewHoldsForTests,
  holdDictationView,
  isDictationViewHeld,
} from "../voice/dictationViewHold.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";

const PROJECT: StoredProject = {
  id: "proj-1",
  name: "One",
  path: "/repo/one",
  status: "background",
};

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Projects an MCP dispatch is waiting on, as every window's manager reports them. */
let leased: Set<string>;
let workspaceClient: {
  evictProject: ReturnType<typeof vi.fn>;
  releaseWindowForProject: ReturnType<typeof vi.fn>;
};

function makeDeps(managers: () => ProjectViewManager[] = () => [backgroundWindow()]) {
  return {
    ptyClient: {} as PtyClient,
    workspaceClient: workspaceClient as unknown as WorkspaceClient,
    projectViewManagers: managers,
  };
}

/** The `webContents.id` of proj-1's cached view in the background window. */
const CACHED_VIEW_ID = 41;
const cachedView = { id: CACHED_VIEW_ID, isDestroyed: () => false } as Electron.WebContents;

/** A window showing some other project, holding a cached view of proj-1. */
function backgroundWindow(): ProjectViewManager {
  return {
    getActiveProjectId: () => "other",
    win: { id: 1, isDestroyed: () => false },
    isMcpDispatchProtected: (projectId: string) => leased.has(projectId),
    isDictationHeld: (projectId: string) =>
      projectId === PROJECT.id && isDictationViewHeld(cachedView),
  } as unknown as ProjectViewManager;
}

function policy(overrides: Partial<Extract<SleepProjectOptions, { initiator: "policy" }>> = {}) {
  return {
    initiator: "policy" as const,
    isStillEligible: vi.fn(() => true),
    allowsTerminals: vi.fn(() => true),
    autoParkedAt: 1234,
    ...overrides,
  };
}

describe("sleepProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leased = new Set();
    _resetDictationViewHoldsForTests();
    panelRecoveryMock.readPanelRecoveryHold.mockReset().mockResolvedValue(null);
    killSnapshot.value = { terminals: [], degraded: false };
    workspaceClient = {
      evictProject: vi.fn(() => true),
      releaseWindowForProject: vi.fn(() => true),
    };
    projectStoreMock.getProjectById.mockReturnValue(PROJECT);
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    hibernationMock.evictProjectRenderer.mockReturnValue(1);
    helpSessionServiceMock.revokeByProjectId.mockReset().mockResolvedValue(undefined);
    // Faithful to the helper's guard contract: the snapshot is read, then the
    // guard gets the last word before anything is killed.
    teardownMock.gracefulTeardownAndJournalProject
      .mockReset()
      .mockImplementation(async (_scopeId, _client, _ws, options) => {
        await flushMicrotasks();
        if (options.beforeKill && !options.beforeKill(killSnapshot.value)) {
          return { confirmed: false, aborted: true, terminalsKilled: 0, sessions: [] };
        }
        return {
          confirmed: true,
          aborted: false,
          terminalsKilled: 1,
          sessions: [{ id: "t1", agentSessionId: "s1" }],
        };
      });
  });

  describe("a policy sleep", () => {
    it("sleeps the project the way a user sleep does, parked and lease-guarded", async () => {
      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({
        status: "slept",
        terminalsKilled: 1,
        rendererViewsEvicted: 1,
        workspaceEvicted: true,
      });
      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      expect(persistenceMock.writeHibernatedMarker).toHaveBeenCalledWith("t1");
      expect(hibernationMock.evictProjectRenderer).toHaveBeenCalledWith("proj-1", {
        protectMcpDispatch: true,
      });
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: 1234,
      });
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledWith("proj-1");
      expect(broadcastMock).toHaveBeenCalledWith(
        CHANNELS.PROJECT_UPDATED,
        expect.objectContaining({ id: "proj-1" })
      );
      // No window is showing it, so there is nothing to drop — and a view that
      // outlived the eviction must not be blanked by it.
      expect(broadcastMock).not.toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });

    it("refuses when a dispatch starts while the kill's snapshot is in flight", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(
        async (_scopeId, _client, _ws, options) => {
          await flushMicrotasks();
          leased.add("proj-1");
          const allowed = options.beforeKill!(killSnapshot.value);
          return { confirmed: false, aborted: !allowed, terminalsKilled: 0, sessions: [] };
        }
      );

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "mcp-dispatch" });
      expect(persistenceMock.writeHibernatedMarker).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("touches nothing while an MCP dispatch is waiting on the project's view", async () => {
      leased.add("proj-1");

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "mcp-dispatch" });
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    });

    it.each(["panel-unrecoverable", "panel-unknown"] as const)(
      "touches nothing while a view reports %s",
      async (hold) => {
        panelRecoveryMock.readPanelRecoveryHold.mockResolvedValue(hold);

        const outcome = await sleepProject("proj-1", policy(), makeDeps());

        expect(outcome).toEqual({ status: "skipped", reason: hold });
        expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
        expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
      }
    );

    it("keeps the view when a draft appears while the kill is in flight", async () => {
      panelRecoveryMock.readPanelRecoveryHold
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("panel-unrecoverable");

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      // The kill already happened, so the outcome owns up to it.
      expect(outcome).toEqual({
        status: "skipped",
        reason: "panel-unrecoverable",
        terminalsKilled: 1,
      });
      expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledTimes(1);
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    // Destroying the view a dictation started from cancels the session and the
    // words still on their way, and its cleanup writes into that view's draft.
    it("waits out a dictation still writing into the project's view, then sleeps (#15920)", async () => {
      const release = holdDictationView(CACHED_VIEW_ID);

      const held = await sleepProject("proj-1", policy(), makeDeps());

      expect(held).toEqual({ status: "skipped", reason: "dictation" });
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();

      release();
      const released = await sleepProject("proj-1", policy(), makeDeps());

      expect(released).toMatchObject({ status: "slept", rendererViewsEvicted: 1 });
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: 1234,
      });
    });

    it("keeps the view when a dictation starts there while the kill is in flight", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(async () => {
        holdDictationView(CACHED_VIEW_ID);
        return {
          confirmed: true,
          aborted: false,
          terminalsKilled: 1,
          sessions: [{ id: "t1", agentSessionId: null }],
        };
      });

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "dictation", terminalsKilled: 1 });
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("treats a window list it can't read as a dispatch it can't rule out", async () => {
      const outcome = await sleepProject(
        "proj-1",
        policy(),
        makeDeps(() => {
          throw new Error("registry tearing down");
        })
      );

      expect(outcome).toEqual({ status: "skipped", reason: "mcp-dispatch" });
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
    });

    it("stops after the revoke when a dispatch started during it", async () => {
      helpSessionServiceMock.revokeByProjectId.mockImplementationOnce(async () => {
        leased.add("proj-1");
      });

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "mcp-dispatch" });
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    });

    it("lets the policy refuse on the kill's own pre-kill snapshot", async () => {
      killSnapshot.value = { terminals: [{ id: "late", projectId: "proj-1" }], degraded: false };
      const allowsTerminals = vi.fn(() => false);

      const outcome = await sleepProject("proj-1", policy({ allowsTerminals }), makeDeps());

      expect(allowsTerminals).toHaveBeenCalledWith(killSnapshot.value);
      expect(outcome).toEqual({ status: "skipped", reason: "ineligible" });
      expect(persistenceMock.writeHibernatedMarker).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("refuses at the kill when the project stopped being a candidate", async () => {
      const isStillEligible = vi.fn(() => true);
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(
        async (_scopeId, _client, _ws, options) => {
          isStillEligible.mockReturnValue(false);
          const allowed = options.beforeKill!(killSnapshot.value);
          return { confirmed: false, aborted: !allowed, terminalsKilled: 0, sessions: [] };
        }
      );

      const outcome = await sleepProject("proj-1", policy({ isStillEligible }), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "ineligible" });
    });

    it("keeps the markers but commits nothing when a dispatch starts during the kill", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(async () => {
        leased.add("proj-1");
        return {
          confirmed: true,
          aborted: false,
          terminalsKilled: 1,
          sessions: [{ id: "t1", agentSessionId: null }],
        };
      });

      const outcome = await sleepProject("proj-1", policy(), makeDeps());

      expect(outcome).toEqual({ status: "skipped", reason: "mcp-dispatch", terminalsKilled: 1 });
      // Its PTYs are gone either way; the markers let the panels restore.
      expect(persistenceMock.writeHibernatedMarker).toHaveBeenCalledWith("t1");
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(workspaceClient.evictProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("still fails closed on an unconfirmed kill", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockResolvedValueOnce({
        confirmed: false,
        aborted: false,
        terminalsKilled: 0,
        sessions: [],
      });

      await expect(sleepProject("proj-1", policy(), makeDeps())).rejects.toBeInstanceOf(AppError);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });
  });

  describe("a user sleep", () => {
    it("reports the plugin work it stopped, read after the kill and before the unload (#14093)", async () => {
      const order: string[] = [];
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(async () => {
        order.push("kill");
        return {
          confirmed: true,
          aborted: false,
          terminalsKilled: 0,
          sessions: [],
        };
      });
      pluginLifecycleMock.notifyProjectPluginsClosed.mockImplementationOnce(() => {
        order.push("unload");
      });
      const pluginWork = vi.fn(() => {
        order.push("read");
        return [
          {
            pluginId: "project__proj-1__acme.sync",
            liveTasks: [{ id: "t1", pluginName: "Sync", title: "Uploading" }],
            pendingCalls: 1,
            runningProcesses: 1,
          },
        ];
      });

      const outcome = await sleepProject(
        "proj-1",
        { initiator: "user" },
        { ...makeDeps(), pluginWork }
      );

      expect(outcome).toMatchObject({
        status: "slept",
        pluginWorkStopped: {
          tasks: [{ pluginName: "Sync", title: "Uploading" }],
          processes: 1,
          calls: 1,
        },
      });
      expect(order).toEqual(["kill", "read", "unload"]);
    });

    it("still sleeps when the plugin work can't be read (#14093)", async () => {
      const outcome = await sleepProject(
        "proj-1",
        { initiator: "user" },
        {
          ...makeDeps(),
          pluginWork: () => {
            throw new Error("registry gone");
          },
        }
      );

      expect(outcome.status).toBe("slept");
      expect(outcome).not.toHaveProperty("pluginWorkStopped");
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledWith("proj-1");
    });

    it("does not ask the views about unsaved work", async () => {
      panelRecoveryMock.readPanelRecoveryHold.mockResolvedValue("panel-unrecoverable");

      const outcome = await sleepProject("proj-1", { initiator: "user" }, makeDeps());

      expect(outcome.status).toBe("slept");
      expect(panelRecoveryMock.readPanelRecoveryHold).not.toHaveBeenCalled();
    });

    it("goes through an MCP dispatch — the user asked", async () => {
      leased.add("proj-1");

      const outcome = await sleepProject("proj-1", { initiator: "user" }, makeDeps());

      expect(outcome.status).toBe("slept");
      expect(hibernationMock.evictProjectRenderer).toHaveBeenCalledWith("proj-1");
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed");
      const [, , , options] = teardownMock.gracefulTeardownAndJournalProject.mock.calls[0]!;
      expect(options.beforeKill).toBeUndefined();
    });

    it("goes through a dictation hold — the user asked", async () => {
      holdDictationView(CACHED_VIEW_ID);

      const outcome = await sleepProject("proj-1", { initiator: "user" }, makeDeps());

      expect(outcome.status).toBe("slept");
      expect(hibernationMock.evictProjectRenderer).toHaveBeenCalledWith("proj-1");
    });

    it("tells a window showing the project to drop it", async () => {
      await sleepProject("proj-1", { initiator: "user" }, makeDeps());
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });

    it("still announces the sleep when the row broadcast fails", async () => {
      broadcastMock.mockImplementationOnce(() => {
        throw new Error("window closing");
      });

      const outcome = await sleepProject("proj-1", { initiator: "user" }, makeDeps());

      expect(outcome.status).toBe("slept");
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });

    it("announces the sleep even when the row is gone by the end", async () => {
      projectStoreMock.getProjectById.mockReturnValueOnce(PROJECT).mockReturnValue(null);

      await sleepProject("proj-1", { initiator: "user" }, makeDeps());

      expect(broadcastMock).not.toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, expect.anything());
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });

    it("fails before revoking anything when there is no terminal host", async () => {
      await expect(
        sleepProject("proj-1", { initiator: "user" }, { ...makeDeps(), ptyClient: null })
      ).rejects.toBeInstanceOf(AppError);
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });
  });

  describe("concurrent sleeps of one project", () => {
    beforeEach(() => {
      // The first sleep's status write is what the second one finds.
      projectStoreMock.updateProjectStatus.mockImplementation(() => {
        projectStoreMock.getProjectById.mockReturnValue({ ...PROJECT, status: "closed" });
        return undefined;
      });
    });

    it("tears the project down once for a double click", async () => {
      const deps = makeDeps();
      const [first, second] = await Promise.all([
        sleepProject("proj-1", { initiator: "user" }, deps),
        sleepProject("proj-1", { initiator: "user" }, deps),
      ]);

      expect(first.status).toBe("slept");
      expect(second).toEqual({ status: "already-closed" });
      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledTimes(1);
      expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledTimes(1);
    });

    it("lets a waiting user retry after the sleep ahead of it failed", async () => {
      const deps = makeDeps();
      teardownMock.gracefulTeardownAndJournalProject.mockImplementationOnce(async () => {
        await flushMicrotasks();
        throw new Error("host gone");
      });
      const first = sleepProject("proj-1", { initiator: "user" }, deps);
      const second = sleepProject("proj-1", { initiator: "user" }, deps);

      await expect(first).rejects.toBeInstanceOf(AppError);
      expect((await second).status).toBe("slept");
      expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledTimes(2);
      // Nothing is left holding the claim.
      expect(await sleepProject("proj-1", policy(), deps)).toEqual({ status: "already-closed" });
    });

    it("skips a policy sleep while another sleep of the project is running", async () => {
      const deps = makeDeps();
      const user = sleepProject("proj-1", { initiator: "user" }, deps);
      const automatic = await sleepProject("proj-1", policy(), deps);
      await user;

      expect(automatic).toEqual({ status: "skipped", reason: "in-flight" });
      expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledTimes(1);
    });

    it("lets a user sleep finish the job a policy sleep backed off from", async () => {
      const deps = makeDeps();
      const isStillEligible = vi.fn(() => true);
      helpSessionServiceMock.revokeByProjectId.mockImplementationOnce(async () => {
        // The user picks the project's sleep up from the reminder meanwhile,
        // and the policy loses interest.
        isStillEligible.mockReturnValue(false);
      });
      const automatic = sleepProject("proj-1", policy({ isStillEligible }), deps);
      const user = sleepProject("proj-1", { initiator: "user" }, deps);

      expect(await automatic).toEqual({ status: "skipped", reason: "ineligible" });
      expect((await user).status).toBe("slept");
      expect(teardownMock.gracefulTeardownAndJournalProject).toHaveBeenCalledTimes(1);
    });
  });
});
