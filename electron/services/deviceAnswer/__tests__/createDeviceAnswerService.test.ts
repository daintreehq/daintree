import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  writes: [] as string[],
  fleetRuns: [] as Array<Record<string, unknown>>,
  lease: null as null | {
    isDriving: (projectId: string, endpoint: { endpointId: string; clientId: string }) => boolean;
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
vi.mock("../../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: async () => ({
    status: "ok",
    text: "❯ 1. Yes\n  2. No",
    lineCount: 2,
    truncated: false,
  }),
}));

import { LOCAL_CLIENT_ID } from "../../../ipc/endpoint.js";
import { createDeviceAnswerService } from "../createDeviceAnswerService.js";
import type { DeviceAnswerServiceDeps } from "../DeviceAnswerService.js";

/** The `answer` dependency the real wiring hands the service. */
function wiredAnswer(): DeviceAnswerServiceDeps["answer"] {
  const service = createDeviceAnswerService() as unknown as { deps: DeviceAnswerServiceDeps };
  return service.deps.answer;
}

const device = { id: "dev-1", name: "Phone" };

describe("createDeviceAnswerService answer", () => {
  beforeEach(() => {
    state.writes = [];
    state.fleetRuns = [{ runId: "run-1", spawnedAt: 100, agentState: "waiting" }];
    state.lease = null;
  });

  it("presses the planned keys with Canopy nowhere in the path", async () => {
    await wiredAnswer()({
      device,
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
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't waiting") });
    expect(state.writes).toEqual([]);
  });
});
