import { beforeEach, describe, expect, it, vi } from "vitest";

const DIALOG = "❯ 1. Yes\n  2. No\n\n Esc to cancel";

const state = {
  writes: [] as string[],
  screen: DIALOG,
  fleetRuns: [] as Array<Record<string, unknown>>,
  lease: null as null | {
    isDriving: (projectId: string, endpoint: { endpointId: string; clientId: string }) => boolean;
  },
  remote: undefined as
    | undefined
    | {
        listWaiting: ReturnType<typeof vi.fn>;
        answer: ReturnType<typeof vi.fn>;
        hostName: (hostId: string) => string | null;
      },
};

const pty = {
  getLiveGeneration: () => 1,
  isLiveGeneration: () => true,
  getTerminalAsync: async () => ({ spawnedAt: 100, isExited: false }),
  getTerminalProjectId: () => "project-1",
  getSerializedStateAsync: async () => null,
  write: (_id: string, data: string) => {
    state.writes.push(data);
    state.screen = redrawFor(state.screen, data);
  },
};

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => pty,
  getFleetSnapshotServiceRef: () => ({ getLastBroadcast: () => ({ runs: state.fleetRuns }) }),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({ getAllAppWebContents: () => [] }));
vi.mock("../../../store.js", () => ({ store: { get: () => undefined, set: () => {} } }));
vi.mock("../../ProjectStore.js", () => ({ projectStore: { getProjectById: () => null } }));
vi.mock("../../ScratchStore.js", () => ({ scratchStore: { getScratchById: () => null } }));
vi.mock("../../DriveLeaseService.js", () => ({ peekDriveLeaseService: () => state.lease }));
vi.mock("../../../remote/runtime.js", () => ({
  getRemoteService: (key: string) => (key === "deviceAnswerHosts" ? state.remote : undefined),
}));
vi.mock("../../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: async () => ({
    status: "ok",
    text: state.screen,
    lineCount: 2,
    truncated: false,
  }),
}));

import { redrawFor } from "../../__tests__/answerRedraw.js";
import { LOCAL_CLIENT_ID } from "../../../ipc/endpoint.js";
import { LOCAL_HOST_ID } from "../../../../shared/types/remoteHosts.js";
import { createDeviceAnswerService } from "../createDeviceAnswerService.js";
import type { DeviceAnswerServiceDeps } from "../DeviceAnswerService.js";

function wiredDeps(): DeviceAnswerServiceDeps {
  const service = createDeviceAnswerService() as unknown as { deps: DeviceAnswerServiceDeps };
  return service.deps;
}

/** The `answer` dependency the real wiring hands the service. */
function wiredAnswer(): DeviceAnswerServiceDeps["answer"] {
  return wiredDeps().answer;
}

const device = { id: "dev-1", name: "Phone" };

/** The question this machine's run is listed with now, as a device would be sent it. */
async function listedQuestion(): Promise<string> {
  const { runs } = await wiredDeps().listWaiting({ hosts: false, read: null });
  return runs.find((run) => run.hostId === LOCAL_HOST_ID)!.questionId!;
}

const HOST_RUN = {
  runId: "run-1",
  spawnedAt: 100,
  project: "api",
  title: null,
  agentId: "codex",
  agentState: "waiting" as const,
  waitingReason: "approval" as const,
  since: 1,
  parked: false,
  snoozed: false,
  screen: DIALOG,
  choices: ["Yes", "No"],
  questionId: "question-of-run-1-0001",
};

describe("createDeviceAnswerService answer", () => {
  beforeEach(() => {
    state.writes = [];
    state.screen = DIALOG;
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "waiting" }];
    state.lease = null;
    state.remote = undefined;
  });

  it("presses the planned keys with Canopy nowhere in the path", async () => {
    await wiredAnswer()({
      device,
      hostId: LOCAL_HOST_ID,
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      questionId: await listedQuestion(),
      stillAllowed: () => null,
    });
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("presses nothing into a later question that offers the same options as the one listed", async () => {
    state.screen = " Run rm -rf build?\n❯ 1. Yes\n  2. No\n\n Esc to cancel";
    const shown = await listedQuestion();
    // Answered at the desktop, and the agent asks again with the same options.
    state.screen = " Run git push --force?\n❯ 1. Yes\n  2. No\n\n Esc to cancel";
    await expect(
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: shown,
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({
      userMessage: "The question changed since this device showed it. Nothing was pressed.",
    });
    expect(state.writes).toEqual([]);

    // Moving the highlight isn't a different question.
    state.screen = " Run rm -rf build?\n  1. Yes\n❯ 2. No\n\n Esc to cancel";
    await wiredAnswer()({
      device,
      hostId: LOCAL_HOST_ID,
      runId: "run-1",
      spawnedAt: 100,
      label: "Yes",
      questionId: shown,
      stillAllowed: () => null,
    });
    expect(state.writes).toEqual(["\x1b[A", "\r"]);
  });

  it("stands in the drive lease as this machine's windows, and presses nothing where a remote Shell drives", async () => {
    const asked: Array<{ endpointId: string; clientId: string }> = [];
    state.lease = {
      isDriving: (_projectId, endpoint) => {
        asked.push(endpoint);
        return false;
      },
    };
    await expect(
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: await listedQuestion(),
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("driven from another screen") });
    expect(asked[0]).toEqual({ endpointId: "device:dev-1", clientId: LOCAL_CLIENT_ID });
    expect(state.writes).toEqual([]);
  });

  it("presses nothing for a run the fleet no longer shows waiting", async () => {
    const questionId = await listedQuestion();
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "working" }];
    await expect(
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId,
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't waiting") });
    expect(state.writes).toEqual([]);
  });

  it("presses the option a redacted label was shown for, and never one named by its secret", async () => {
    state.screen = "❯ 1. Yes\n  2. Use token=abcdef123456\n  3. No\n\n Esc to cancel";
    const questionId = await listedQuestion();
    const press = (label: string) =>
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label,
        questionId,
        stillAllowed: () => null,
      });
    await expect(press("Use token=abcdef123456")).rejects.toMatchObject({
      userMessage: expect.stringContaining("Nothing was pressed"),
    });
    expect(state.writes).toEqual([]);
    await press("Use token=[redacted]");
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("presses nothing when two options redact to the same label", async () => {
    state.screen =
      "❯ 1. Use token=abcdef123456\n  2. Use token=zyxwvu987654\n  3. No\n\n Esc to cancel";
    const refused = wiredAnswer()({
      device,
      hostId: LOCAL_HOST_ID,
      runId: "run-1",
      spawnedAt: 100,
      label: "Use token=[redacted]",
      // Such a list is offered with no options, so no question either.
      questionId: "question-of-run-1-0001",
      stillAllowed: () => null,
    });
    await expect(refused).rejects.toMatchObject({
      userMessage: expect.not.stringMatching(/abcdef|zyxwvu/),
    });
    expect(state.writes).toEqual([]);
  });
});

function unreadHost(hostId: string, host: string, status: string) {
  return { hostId, host, status, runs: [], omitted: [], waiting: null };
}

const { screen: _screen, choices: _choices, questionId: _questionId, ...HOST_SUMMARY } = HOST_RUN;

describe("createDeviceAnswerService and connected hosts", () => {
  beforeEach(() => {
    state.writes = [];
    state.screen = DIALOG;
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "waiting" }];
    state.lease = null;
    state.remote = {
      listWaiting: vi.fn(async () => [
        {
          hostId: "studio-03",
          host: "studio-03",
          status: "ok",
          runs: [{ ...HOST_RUN }],
          omitted: [],
          waiting: 1,
        },
        unreadHost("studio-04", "studio-04", "needs-update"),
        unreadHost("mini", "Mini", "not-connected"),
      ]),
      answer: vi.fn(async () => {}),
      hostName: (hostId) => (hostId === "studio-03" ? "studio-03" : null),
    };
  });

  it("lists this machine's runs with every connected host's, each named with its machine", async () => {
    const { runs, hosts, coverage } = await wiredDeps().listWaiting({ hosts: true, read: null });
    expect(runs.map((run) => [run.hostId, run.runId])).toEqual([
      // The host's run asks for approval; this machine's sits at its prompt.
      ["studio-03", "run-1"],
      [LOCAL_HOST_ID, "run-1"],
    ]);
    // Only the machines read say how much of them was.
    expect(coverage).toEqual([
      { hostId: LOCAL_HOST_ID, host: runs[1]!.host, listed: 1, waiting: 1 },
      { hostId: "studio-03", host: "studio-03", listed: 1, waiting: 1 },
    ]);
    expect(runs[0]!.host).toBe("studio-03");
    expect(runs[1]!.host).not.toBe("");
    expect(hosts).toEqual([
      { hostId: "studio-03", host: "studio-03", status: "ok" },
      { hostId: "studio-04", host: "studio-04", status: "needs-update" },
      { hostId: "mini", host: "Mini", status: "not-connected" },
    ]);
  });

  it("lists only this machine's runs where remote hosts aren't running", async () => {
    state.remote = undefined;
    const { runs, hosts, hostsUnlisted } = await wiredDeps().listWaiting({ hosts: true, read: null });
    expect(runs.map((run) => run.hostId)).toEqual([LOCAL_HOST_ID]);
    expect(hosts).toEqual([]);
    expect(hostsUnlisted).toBeFalsy();
  });

  it("asks no host for a page that can't answer hosts' runs", async () => {
    const { runs, hosts, hostsUnlisted } = await wiredDeps().listWaiting({ hosts: false, read: null });
    expect(state.remote!.listWaiting).not.toHaveBeenCalled();
    expect(runs.map((run) => run.hostId)).toEqual([LOCAL_HOST_ID]);
    expect(hosts).toEqual([]);
    expect(hostsUnlisted).toBeFalsy();
  });

  it("still lists this machine's runs when the hosts can't be listed at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.remote!.listWaiting.mockImplementationOnce(() => {
      throw new Error("registry unreadable");
    });
    const { runs, hosts, hostsUnlisted } = await wiredDeps().listWaiting({ hosts: true, read: null });
    expect(runs.map((run) => run.hostId)).toEqual([LOCAL_HOST_ID]);
    // An empty list here is one that couldn't be read, not one with no hosts.
    expect(hosts).toEqual([]);
    expect(hostsUnlisted).toBe(true);
    warn.mockRestore();
  });

  it("says which machine cut its list, and that a host which can't say may have", async () => {
    state.fleetRuns = Array.from({ length: 21 }, (_, i) => ({
      runId: `local-${i}`,
      spawnedAt: 100,
      agentState: "waiting",
      waitingReason: "prompt",
      since: i,
    }));
    state.remote!.listWaiting.mockResolvedValueOnce([
      {
        hostId: "studio-03",
        host: "studio-03",
        status: "ok",
        runs: [{ ...HOST_RUN }],
        omitted: [{ ...HOST_SUMMARY, runId: "run-2" }],
        waiting: 30,
      },
      { hostId: "old", host: "Old", status: "ok", runs: [], omitted: [], waiting: null },
    ]);
    const { runs, omitted, coverage } = await wiredDeps().listWaiting({ hosts: true, read: null });
    expect(runs).toHaveLength(21);
    expect(coverage).toEqual([
      { hostId: LOCAL_HOST_ID, host: expect.any(String), listed: 20, waiting: 21 },
      { hostId: "studio-03", host: "studio-03", listed: 1, waiting: 30 },
      { hostId: "old", host: "Old", listed: 0, waiting: null },
    ]);
    // The host's unread approval comes before this machine's unread hand-back.
    expect(omitted.map((run) => [run.hostId, run.runId, run.agentName])).toEqual([
      ["studio-03", "run-2", "Codex"],
      [LOCAL_HOST_ID, "local-20", null],
    ]);
  });

  it("reads a run a device picked only on the machine it waits on", async () => {
    state.fleetRuns = Array.from({ length: 21 }, (_, i) => ({
      runId: `local-${i}`,
      spawnedAt: 100,
      agentState: "waiting",
      since: i,
    }));
    const local = await wiredDeps().listWaiting({
      hosts: true,
      read: { hostId: LOCAL_HOST_ID, runId: "local-20", spawnedAt: 100 },
    });
    expect(local.runs.some((run) => run.runId === "local-20")).toBe(true);
    expect(state.remote!.listWaiting).toHaveBeenLastCalledWith({ read: null });

    const remote = await wiredDeps().listWaiting({
      hosts: true,
      read: { hostId: "studio-03", runId: "local-20", spawnedAt: 100 },
    });
    // Same id here, but the pick was the host's: this machine reads its usual runs.
    expect(remote.omitted.map((run) => run.runId)).toEqual(["local-20"]);
    expect(state.remote!.listWaiting).toHaveBeenLastCalledWith({
      read: { hostId: "studio-03", runId: "local-20", spawnedAt: 100 },
    });
  });

  it("sends a host's run to that host, and presses nothing here though a run of the same id waits", async () => {
    await wiredAnswer()({
      device,
      hostId: "studio-03",
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      questionId: HOST_RUN.questionId,
      stillAllowed: () => null,
    });
    // The host checks the question; this machine only passes it on.
    expect(state.remote!.answer).toHaveBeenCalledWith({
      hostId: "studio-03",
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      questionId: HOST_RUN.questionId,
    });
    expect(state.writes).toEqual([]);
  });

  it("asks the device's standing here before the host is asked", async () => {
    await expect(
      wiredAnswer()({
        device,
        hostId: "studio-03",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: HOST_RUN.questionId,
        stillAllowed: () => "This device was removed. Nothing more was pressed.",
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("removed") });
    expect(state.remote!.answer).not.toHaveBeenCalled();
  });

  it("never answers a host's run here when remote hosts aren't running", async () => {
    state.remote = undefined;
    await expect(
      wiredAnswer()({
        device,
        hostId: "studio-03",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: await listedQuestion(),
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Nothing was pressed") });
    expect(state.writes).toEqual([]);
  });

  it("names a connected host for the audit, and no other", () => {
    const deps = wiredDeps();
    expect(deps.hostName?.("studio-03")).toBe("studio-03");
    expect(deps.hostName?.("gone")).toBeNull();
  });
});
