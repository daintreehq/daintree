// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIALOG = "❯ 1. Yes\n  2. No\n\n Esc to cancel";

const state = {
  writes: [] as string[],
  generationChecks: 0,
  screen: DIALOG,
  onWrite: null as null | ((count: number) => void),
  driving: (
    _projectId: string,
    _endpoint: { endpointId: string; clientId: string; linkSessionId?: string }
  ) => true,
};

const pty = {
  getLiveGeneration: () => 1,
  isLiveGeneration: () => {
    state.generationChecks += 1;
    return true;
  },
  getTerminalAsync: async () => ({ spawnedAt: 100, isExited: false }),
  getTerminalProjectId: () => "project-1",
  getSerializedStateAsync: async () => null,
  write: (_id: string, data: string) => {
    state.writes.push(data);
    state.onWrite?.(state.writes.length);
  },
};

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => pty,
  getFleetSnapshotServiceRef: () => ({
    getLastBroadcast: () => ({
      runs: [{ runId: "run-1", spawnedAt: 100, agentState: "waiting", workspaceId: "project-1" }],
    }),
  }),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: () => ({ name: "api" }) },
}));
vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: { getScratchById: () => null },
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => ({
    isDriving: (
      projectId: string,
      endpoint: { endpointId: string; clientId: string; linkSessionId?: string }
    ) =>
      state.driving(projectId, endpoint),
  }),
}));
vi.mock("../../../services/plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: async () => ({
    status: "ok",
    text: state.screen,
    lineCount: 4,
    truncated: false,
  }),
}));

import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { DeviceAnswerHostsClient } from "../client.js";
import { installDeviceAnswerHost } from "../hostInstall.js";

const HOST = "studio-03";

let dir: string;
let sessions: { host: LinkSession; client: LinkSession };
let uninstall: () => void;
let client: DeviceAnswerHostsClient;

const answer = (label: string) =>
  client.answer({ hostId: HOST, runId: "run-1", spawnedAt: 100, label });

beforeEach(async () => {
  state.writes = [];
  state.generationChecks = 0;
  state.screen = DIALOG;
  state.onWrite = null;
  state.driving = () => true;
  dir = await makeTempDir();
  sessions = await openSessionPair(dir);
  uninstall = installDeviceAnswerHost({
    sessions: [
      {
        session: sessions.host,
        client: { clientId: "shell-1", clientName: "Greg's Mac", platform: "darwin" },
        sessionId: "s1",
      },
    ],
    onSession: () => () => {},
  });
  client = new DeviceAnswerHostsClient({
    hosts: () => [{ hostId: HOST, name: HOST }],
    sessionFor: () => sessions.client,
    touch: () => {},
    hold: () => () => {},
  });
});

afterEach(async () => {
  uninstall();
  sessions.host.close("test");
  sessions.client.close("test");
  await removeTempDir(dir);
});

describe("a host answering for a device paired with its Shell", () => {
  it("lists its own screens with secrets redacted before they leave, and presses the option as listed", async () => {
    state.screen = "❯ 1. Yes\n  2. Use token=abcdef123456\n  3. No\n\n Esc to cancel";
    const [listed] = await client.listWaiting();
    expect(listed!.status).toBe("ok");
    expect(JSON.stringify(listed)).not.toContain("abcdef123456");
    expect(listed!.runs[0]!.choices).toEqual(["Yes", "Use token=[redacted]", "No"]);

    await answer("Use token=[redacted]");
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("stands as the Shell's windows in its lease, and presses nothing where the Shell couldn't type", async () => {
    const asked: Array<{ endpointId: string; clientId: string; linkSessionId?: string }> = [];
    state.driving = (_projectId, endpoint) => {
      asked.push(endpoint);
      return false;
    };
    await expect(answer("Yes")).rejects.toMatchObject({
      userMessage: expect.stringContaining("driven from another screen"),
    });
    expect(asked[0]!.endpointId).toMatch(/^device-answer:/);
    expect(asked[0]!.clientId).toBe("shell-1");
    expect(asked[0]!.linkSessionId).toBe("s1");
    expect(state.writes).toEqual([]);
  });

  it("stops between keys when another screen takes the project", async () => {
    let taken = false;
    state.driving = () => !taken;
    state.onWrite = () => {
      taken = true;
    };
    await expect(answer("No")).rejects.toMatchObject({
      userMessage: expect.stringContaining("Another screen took control"),
    });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("stops between keys when the link to the Shell drops", async () => {
    state.onWrite = (count) => {
      if (count === 1) sessions.host.close("test");
    };
    await expect(answer("No")).rejects.toMatchObject({
      userMessage: expect.stringContaining("may have been pressed"),
    });
    // The next key was weighed, and not pressed.
    await waitFor(() => state.generationChecks >= 2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("presses nothing for an option that isn't on its screen", async () => {
    await expect(answer("Maybe")).rejects.toMatchObject({
      userMessage: expect.stringContaining("Nothing was pressed"),
    });
    expect(state.writes).toEqual([]);
  });
});
