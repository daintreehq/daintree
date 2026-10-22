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
      stillAllowed: () => null,
    });
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
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
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("driven from another screen") });
    expect(asked[0]).toEqual({ endpointId: "device:dev-1", clientId: LOCAL_CLIENT_ID });
    expect(state.writes).toEqual([]);
  });

  it("presses nothing for a run the fleet no longer shows waiting", async () => {
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "working" }];
    await expect(
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't waiting") });
    expect(state.writes).toEqual([]);
  });

  it("presses the option a redacted label was shown for, and never one named by its secret", async () => {
    state.screen = "❯ 1. Yes\n  2. Use token=abcdef123456\n  3. No\n\n Esc to cancel";
    const press = (label: string) =>
      wiredAnswer()({
        device,
        hostId: LOCAL_HOST_ID,
        runId: "run-1",
        spawnedAt: 100,
        label,
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
      stillAllowed: () => null,
    });
    await expect(refused).rejects.toMatchObject({
      userMessage: expect.not.stringMatching(/abcdef|zyxwvu/),
    });
    expect(state.writes).toEqual([]);
  });
});

describe("createDeviceAnswerService and connected hosts", () => {
  beforeEach(() => {
    state.writes = [];
    state.screen = DIALOG;
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "waiting" }];
    state.lease = null;
    state.remote = {
      listWaiting: vi.fn(async () => [
        { hostId: "studio-03", host: "studio-03", status: "ok", runs: [{ ...HOST_RUN }] },
        { hostId: "studio-04", host: "studio-04", status: "needs-update", runs: [] },
      ]),
      answer: vi.fn(async () => {}),
      hostName: (hostId) => (hostId === "studio-03" ? "studio-03" : null),
    };
  });

  it("lists this machine's runs with every connected host's, each named with its machine", async () => {
    const { runs, hosts } = await wiredDeps().listWaiting();
    expect(runs.map((run) => [run.hostId, run.runId])).toEqual([
      // The host's run has waited longest.
      ["studio-03", "run-1"],
      [LOCAL_HOST_ID, "run-1"],
    ]);
    expect(runs[0]!.host).toBe("studio-03");
    expect(runs[1]!.host).not.toBe("");
    expect(hosts).toEqual([
      { hostId: "studio-03", host: "studio-03", status: "ok" },
      { hostId: "studio-04", host: "studio-04", status: "needs-update" },
    ]);
  });

  it("lists only this machine's runs where remote hosts aren't running", async () => {
    state.remote = undefined;
    const { runs, hosts } = await wiredDeps().listWaiting();
    expect(runs.map((run) => run.hostId)).toEqual([LOCAL_HOST_ID]);
    expect(hosts).toEqual([]);
  });

  it("sends a host's run to that host, and presses nothing here though a run of the same id waits", async () => {
    await wiredAnswer()({
      device,
      hostId: "studio-03",
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      stillAllowed: () => null,
    });
    expect(state.remote!.answer).toHaveBeenCalledWith({
      hostId: "studio-03",
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
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
