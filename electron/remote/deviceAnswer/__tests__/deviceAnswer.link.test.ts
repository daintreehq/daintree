// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingRunView } from "../../../services/deviceAnswer/deviceAnswerRuns.js";
import { answerRefused } from "../../../services/terminalAnswer.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { DeviceAnswerHostsClient } from "../client.js";
import {
  HOST_ANSWER_BUDGET_MS,
  installDeviceAnswerHostWith,
  type DeviceAnswerHostDeps,
} from "../host.js";
import { DeviceAnswerLinkMethod, DeviceAnswerListPayloadSchema } from "../linkMethods.js";

const HOST = "studio-03";
const SHELL_CLIENT = "shell-client-1";

const RUN: WaitingRunView = {
  runId: "run-1",
  spawnedAt: 100,
  project: "daintree",
  title: "Codex",
  agentId: "codex",
  agentState: "waiting",
  waitingReason: "approval",
  since: 1,
  parked: false,
  snoozed: false,
  screen: "❯ 1. Yes\n  2. No",
  choices: ["Yes", "No"],
};

type AnswerRequest = Parameters<DeviceAnswerHostDeps["answer"]>[0];

let dir: string;
let pairs: Array<{ host: LinkSession; client: LinkSession }>;
let sessions: { host: LinkSession; client: LinkSession };
let answered: AnswerRequest[];
let hostDeps: DeviceAnswerHostDeps;
let uninstall: () => void;
let touch: ReturnType<typeof vi.fn<(hostId: string) => void>>;
let released: ReturnType<typeof vi.fn<() => void>>;
let hold: ReturnType<typeof vi.fn<(hostId: string) => () => void>>;
let sessionByHost: Map<string, LinkSession>;
let client: DeviceAnswerHostsClient;

async function pair(): Promise<{ host: LinkSession; client: LinkSession }> {
  const next = await openSessionPair(dir);
  pairs.push(next);
  return next;
}

function serve(session: LinkSession, deps: DeviceAnswerHostDeps): () => void {
  return installDeviceAnswerHostWith(
    {
      sessions: [
        {
          session,
          client: { clientId: SHELL_CLIENT, clientName: "Greg's Mac", platform: "darwin" },
        },
      ],
      onSession: () => () => {},
    },
    deps
  );
}

beforeEach(async () => {
  dir = await makeTempDir();
  pairs = [];
  sessions = await pair();
  answered = [];
  hostDeps = {
    list: vi.fn(async () => [RUN]),
    answer: vi.fn(async (request: AnswerRequest) => {
      answered.push(request);
    }),
  };
  uninstall = serve(sessions.host, hostDeps);
  touch = vi.fn();
  released = vi.fn();
  hold = vi.fn(() => released);
  sessionByHost = new Map([[HOST, sessions.client]]);
  client = new DeviceAnswerHostsClient({
    hosts: () => [
      { hostId: HOST, name: HOST },
      { hostId: "studio-04", name: "studio-04" },
    ],
    sessionFor: (hostId) => sessionByHost.get(hostId) ?? null,
    touch,
    hold,
  });
});

afterEach(async () => {
  uninstall();
  for (const { host, client: shell } of pairs) {
    host.close("test");
    shell.close("test");
  }
  await removeTempDir(dir);
});

describe("answering a connected host's agents from a device paired with the Shell", () => {
  it("lists the host's runs as the host read them, under the name this Shell knows it by", async () => {
    const listed = await client.listWaiting();
    expect(listed).toEqual([{ hostId: HOST, host: HOST, status: "ok", runs: [RUN] }]);
    expect(hostDeps.list).toHaveBeenCalledTimes(1);
    // A device watching it is using it; a host with no link is neither read nor kept up.
    expect(touch).toHaveBeenCalledWith(HOST);
    expect(touch).not.toHaveBeenCalledWith("studio-04");
  });

  it("names a host from before these methods as needing an update, and presses nothing there", async () => {
    const old = await pair();
    sessionByHost.set("studio-04", old.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")).toEqual({
      hostId: "studio-04",
      host: "studio-04",
      status: "needs-update",
      runs: [],
    });
    await expect(
      client.answer({ hostId: "studio-04", runId: "run-1", spawnedAt: 100, label: "Yes" })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("needs a newer Daintree") });
  });

  it("shows nothing of a list that isn't one, and keeps listing the hosts that answered", async () => {
    const odd = await pair();
    odd.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({
        runs: [{ ...RUN, choices: ["x".repeat(500)] }],
      })
    );
    sessionByHost.set("studio-04", odd.client);
    const listed = await client.listWaiting();
    expect(listed).toEqual([
      { hostId: HOST, host: HOST, status: "ok", runs: [RUN] },
      { hostId: "studio-04", host: "studio-04", status: "unreachable", runs: [] },
    ]);
  });

  it("answers as the Shell's own windows in the host's lease, holding the link while it does", async () => {
    await client.answer({ hostId: HOST, runId: "run-1", spawnedAt: 100, label: "No" });
    expect(answered).toHaveLength(1);
    const [request] = answered;
    expect(request).toMatchObject({ runId: "run-1", spawnedAt: 100, label: "No" });
    expect(request!.standing.clientId).toBe(SHELL_CLIENT);
    expect(request!.standing.endpointId).toMatch(/^device-answer:/);
    expect(request!.stillAllowed()).toBeNull();
    expect(hold).toHaveBeenCalledWith(HOST);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("carries the host's own refusal back in its words", async () => {
    vi.mocked(hostDeps.answer).mockRejectedValueOnce(
      answerRefused("This project is being driven from another screen. Nothing was pressed.")
    );
    await expect(
      client.answer({ hostId: HOST, runId: "run-1", spawnedAt: 100, label: "Yes" })
    ).rejects.toMatchObject({
      userMessage: "This project is being driven from another screen. Nothing was pressed.",
    });
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("refuses on the host anything but a listed label, before its terminals are touched", async () => {
    for (const payload of [
      { runId: "", spawnedAt: 100, label: "Yes" },
      { runId: "run-1", spawnedAt: 100, label: "   " },
      { runId: "run-1", spawnedAt: 100, label: "x".repeat(201) },
      { runId: "run-1", spawnedAt: Number.NaN, label: "Yes" },
    ]) {
      await expect(
        sessions.client.call(DeviceAnswerLinkMethod.ANSWER, payload)
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });

  it("stops pressing when the Shell's link closes mid-answer, and says it may have been pressed", async () => {
    let carryOn!: () => void;
    const gate = new Promise<void>((resolve) => (carryOn = resolve));
    let afterClose: string | null = null;
    vi.mocked(hostDeps.answer).mockImplementationOnce(async ({ stillAllowed }) => {
      await gate;
      afterClose = stillAllowed();
    });
    const answering = client.answer({ hostId: HOST, runId: "run-1", spawnedAt: 100, label: "Yes" });
    await waitFor(() => vi.mocked(hostDeps.answer).mock.calls.length === 1);
    sessions.client.close("test");
    await expect(answering).rejects.toMatchObject({
      userMessage: expect.stringContaining("may have been pressed"),
    });
    await waitFor(() => !sessions.host.isOpen);
    carryOn();
    await waitFor(() => afterClose !== null);
    expect(afterClose).toContain("Nothing more was pressed");
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("stops pressing once the host's budget for one answer runs out", async () => {
    uninstall();
    let now = 1_000;
    let late: string | null = null;
    uninstall = serve(sessions.host, {
      ...hostDeps,
      now: () => now,
      answer: async ({ stillAllowed }) => {
        now += HOST_ANSWER_BUDGET_MS + 1;
        late = stillAllowed();
      },
    });
    await client.answer({ hostId: HOST, runId: "run-1", spawnedAt: 100, label: "Yes" });
    expect(late).toContain("took too long");
  });

  it("asks nothing of a host that isn't connected or isn't in the list", async () => {
    await expect(
      client.answer({ hostId: "studio-04", runId: "run-1", spawnedAt: 100, label: "Yes" })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't connected") });
    await expect(
      client.answer({ hostId: "gone", runId: "run-1", spawnedAt: 100, label: "Yes" })
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("isn't in Daintree's host list"),
    });
    expect(hold).not.toHaveBeenCalled();
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });

  it("serves nothing once uninstalled", async () => {
    uninstall();
    const listed = await client.listWaiting();
    expect(listed).toEqual([{ hostId: HOST, host: HOST, status: "needs-update", runs: [] }]);
  });
});
