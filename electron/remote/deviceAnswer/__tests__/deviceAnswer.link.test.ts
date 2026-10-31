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
  type DeviceAnswerSessionContext,
} from "../host.js";
import {
  DeviceAnswerAnswerPayloadSchema,
  DeviceAnswerLinkMethod,
  DeviceAnswerListPayloadSchema,
} from "../linkMethods.js";

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
  questionId: "question-of-run-1-0001",
};
const QUESTION = RUN.questionId!;

/** A host read whole: everything waiting there was listed. */
function readHost(hostId: string, host: string, runs: WaitingRunView[] = [RUN]) {
  return { hostId, host, status: "ok", runs, omitted: [], waiting: runs.length };
}

/** A host with nothing read from it, so nothing said of what waits there. */
function unreadHost(hostId: string, host: string, status: string) {
  return { hostId, host, status, runs: [], omitted: [], waiting: null };
}

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
          sessionId: "s1",
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
    list: vi.fn(async () => ({ runs: [RUN], omitted: [], waiting: 1 })),
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
    expect(listed).toEqual([
      readHost(HOST, HOST),
      unreadHost("studio-04", "studio-04", "not-connected"),
    ]);
    expect(hostDeps.list).toHaveBeenCalledTimes(1);
    // A device watching it is using it; a host with no link is neither read nor kept up.
    expect(touch).toHaveBeenCalledWith(HOST);
    expect(touch).not.toHaveBeenCalledWith("studio-04");
  });

  it("lists every host it knows, saying which aren't connected, and reaches only the connected", async () => {
    const closedCall = vi.fn(async () => ({ runs: [RUN] }));
    const failing = vi.fn(async () => {
      throw new Error("link dropped");
    });
    const many = new DeviceAnswerHostsClient({
      hosts: () => [
        { hostId: HOST, name: "Studio" },
        { hostId: "mini", name: "Mini" },
        { hostId: "closed", name: "Closed" },
        { hostId: "flaky", name: "" },
      ],
      sessionFor: (hostId) =>
        hostId === HOST
          ? sessions.client
          : hostId === "closed"
            ? { isOpen: false, call: closedCall }
            : hostId === "flaky"
              ? { isOpen: true, call: failing }
              : null,
      touch,
      hold,
    });
    expect(await many.listWaiting()).toEqual([
      readHost(HOST, "Studio"),
      unreadHost("mini", "Mini", "not-connected"),
      unreadHost("closed", "Closed", "not-connected"),
      unreadHost("flaky", "flaky", "unreachable"),
    ]);
    expect(closedCall).not.toHaveBeenCalled();
    expect(touch.mock.calls.map(([hostId]) => hostId).sort()).toEqual([HOST, "flaky"].sort());
    expect(hold).not.toHaveBeenCalled();
  });

  it("names a host from before these methods as needing an update, and presses nothing there", async () => {
    const old = await pair();
    sessionByHost.set("studio-04", old.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")).toEqual(
      unreadHost("studio-04", "studio-04", "needs-update")
    );
    await expect(
      client.answer({
        hostId: "studio-04",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("needs a newer Daintree") });
  });

  it("shows nothing of a list that isn't one, and keeps listing the hosts that answered", async () => {
    const odd = await pair();
    odd.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({
        runs: [{ ...RUN, choices: ["x".repeat(500)] }],
        questionIds: true,
      })
    );
    sessionByHost.set("studio-04", odd.client);
    const listed = await client.listWaiting();
    expect(listed).toEqual([
      readHost(HOST, HOST),
      unreadHost("studio-04", "studio-04", "unreachable"),
    ]);
  });

  it("answers as the Shell's own windows in the host's lease, holding the link while it does", async () => {
    await client.answer({
      hostId: HOST,
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      questionId: QUESTION,
    });
    expect(answered).toHaveLength(1);
    const [request] = answered;
    expect(request).toMatchObject({
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      questionId: QUESTION,
    });
    expect(request!.standing.clientId).toBe(SHELL_CLIENT);
    expect(request!.standing.endpointId).toMatch(/^device-answer:/);
    // The host's own session id, never only the client id the Shell claimed (#14679).
    expect(request!.standing.linkSessionId).toBe("s1");
    expect(request!.stillAllowed()).toBeNull();
    expect(hold).toHaveBeenCalledWith(HOST);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("carries the host's own refusal back in its words", async () => {
    vi.mocked(hostDeps.answer).mockRejectedValueOnce(
      answerRefused("This project is being driven from another screen. Nothing was pressed.")
    );
    await expect(
      client.answer({
        hostId: HOST,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({
      userMessage: "This project is being driven from another screen. Nothing was pressed.",
    });
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("refuses on the host anything but a listed label with its question, before its terminals are touched", async () => {
    for (const payload of [
      { runId: "", spawnedAt: 100, label: "Yes", questionId: QUESTION },
      { runId: "run-1", spawnedAt: 100, label: "   ", questionId: QUESTION },
      { runId: "run-1", spawnedAt: 100, label: "x".repeat(201), questionId: QUESTION },
      { runId: "run-1", spawnedAt: Number.NaN, label: "Yes", questionId: QUESTION },
      { runId: "run-1", spawnedAt: 100, label: "Yes" },
      { runId: "run-1", spawnedAt: 100, label: "Yes", questionId: "not one" },
    ]) {
      await expect(
        sessions.client.call(DeviceAnswerLinkMethod.ANSWER_QUESTION, payload)
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });

  it("refuses a Shell from before answers named their question, pressing nothing", async () => {
    await expect(
      sessions.client.call(DeviceAnswerLinkMethod.ANSWER, {
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Nothing was pressed") });
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });

  it("offers nothing to answer on a host that can't check the question, and never asks it to press by label alone", async () => {
    // A host from after device answers but before their question: it lists,
    // and answers the older method by label.
    const older = await pair();
    const { questionId: _questionId, ...unchecked } = RUN;
    older.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({
        runs: [unchecked],
      })
    );
    const pressedByLabel = vi.fn(() => null);
    older.host.registerCallHandler(
      DeviceAnswerLinkMethod.ANSWER,
      DeviceAnswerAnswerPayloadSchema,
      pressedByLabel
    );
    sessionByHost.set("studio-04", older.client);

    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")).toEqual(
      unreadHost("studio-04", "studio-04", "needs-update")
    );
    await expect(
      client.answer({
        hostId: "studio-04",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({
      userMessage:
        "studio-04 needs a newer Daintree to be answered from another device. Nothing was pressed.",
    });
    expect(pressedByLabel).not.toHaveBeenCalled();
    // The link outlives the refusal.
    expect(older.client.isOpen).toBe(true);
  });

  it("names a host that can't check the question as needing an update even with nothing waiting", async () => {
    const older = await pair();
    older.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({ runs: [] })
    );
    sessionByHost.set("studio-04", older.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")?.status).toBe("needs-update");
  });

  it("stops pressing when the Shell's link closes mid-answer, and says it may have been pressed", async () => {
    let carryOn!: () => void;
    const gate = new Promise<void>((resolve) => (carryOn = resolve));
    let afterClose: string | null = null;
    vi.mocked(hostDeps.answer).mockImplementationOnce(async ({ stillAllowed }) => {
      await gate;
      afterClose = stillAllowed();
    });
    const answering = client.answer({
      hostId: HOST,
      runId: "run-1",
      spawnedAt: 100,
      label: "Yes",
      questionId: QUESTION,
    });
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
    await client.answer({
      hostId: HOST,
      runId: "run-1",
      spawnedAt: 100,
      label: "Yes",
      questionId: QUESTION,
    });
    expect(late).toContain("took too long");
  });

  it("asks nothing of a host that isn't connected or isn't in the list", async () => {
    await expect(
      client.answer({
        hostId: "studio-04",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't connected") });
    await expect(
      client.answer({
        hostId: "gone",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("isn't in Daintree's host list"),
    });
    expect(hold).not.toHaveBeenCalled();
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });

  it("serves nothing once uninstalled", async () => {
    uninstall();
    const listed = await client.listWaiting();
    expect(listed).toEqual([
      unreadHost(HOST, HOST, "needs-update"),
      unreadHost("studio-04", "studio-04", "not-connected"),
    ]);
  });

  it("serves a Shell that attaches after it started, until it is uninstalled", async () => {
    const late = await pair();
    const listeners: Array<(ctx: DeviceAnswerSessionContext) => void> = [];
    const off = vi.fn();
    const stop = installDeviceAnswerHostWith(
      {
        sessions: [],
        onSession: (listener) => {
          listeners.push(listener);
          return off;
        },
      },
      hostDeps
    );
    listeners[0]!({
      session: late.host,
      client: { clientId: SHELL_CLIENT, clientName: "Greg's Mac", platform: "darwin" },
      sessionId: "s2",
    });
    sessionByHost.set("studio-04", late.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")?.status).toBe("ok");
    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("says how many wait on a host past the runs it read, and has the one picked read there alone", async () => {
    const omitted = { ...RUN, runId: "run-2" } as Partial<WaitingRunView>;
    delete omitted.screen;
    delete omitted.choices;
    delete omitted.questionId;
    vi.mocked(hostDeps.list).mockResolvedValue({
      runs: [RUN],
      omitted: [omitted as never],
      waiting: 23,
    });
    const other = await pair();
    const otherList = vi.fn(async () => ({ runs: [], omitted: [], waiting: 0 }));
    const stop = serve(other.host, { ...hostDeps, list: otherList });
    sessionByHost.set("studio-04", other.client);

    const listed = await client.listWaiting({
      read: { hostId: HOST, runId: "run-2", spawnedAt: 100 },
    });
    expect(listed[0]).toEqual({
      hostId: HOST,
      host: HOST,
      status: "ok",
      runs: [RUN],
      omitted: [omitted],
      waiting: 23,
    });
    expect(hostDeps.list).toHaveBeenLastCalledWith({ read: { runId: "run-2", spawnedAt: 100 } });
    // The pick is that host's run; no other host is asked to read it.
    expect(otherList).toHaveBeenLastCalledWith({ read: null });
    stop();
  });

  it("never presents a host that doesn't say how many wait there as complete", async () => {
    const older = await pair();
    older.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({ runs: [RUN], questionIds: true })
    );
    sessionByHost.set("studio-04", older.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")).toEqual({
      ...readHost("studio-04", "studio-04"),
      waiting: null,
    });
  });

  it("shows nothing of a host that counts fewer waiting than it listed", async () => {
    const odd = await pair();
    odd.host.registerCallHandler(
      DeviceAnswerLinkMethod.LIST,
      DeviceAnswerListPayloadSchema,
      () => ({ runs: [RUN], omitted: [], waiting: 0, questionIds: true })
    );
    sessionByHost.set("studio-04", odd.client);
    const listed = await client.listWaiting();
    expect(listed.find((host) => host.hostId === "studio-04")).toEqual(
      unreadHost("studio-04", "studio-04", "unreachable")
    );
  });

  it("asks nothing of a host whose link closed after it was listed", async () => {
    await client.listWaiting();
    sessions.client.close("test");
    await expect(
      client.answer({
        hostId: HOST,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't connected") });
    expect(hold).not.toHaveBeenCalled();
    expect(hostDeps.answer).not.toHaveBeenCalled();
  });
});

describe("what a Shell tells a device when a host's reply doesn't come", () => {
  const failing = (code: string) => ({
    isOpen: true,
    call: vi.fn(async () => {
      throw Object.assign(new Error(code), { code });
    }),
  });

  function clientOver(session: ReturnType<typeof failing>, release = vi.fn()) {
    return {
      release,
      client: new DeviceAnswerHostsClient({
        hosts: () => [{ hostId: HOST, name: HOST }],
        sessionFor: () => session,
        touch: () => {},
        hold: () => release,
      }),
    };
  }

  it("lists a host that didn't answer in time as unreachable", async () => {
    const { client: shell } = clientOver(failing("OUTCOME_UNKNOWN"));
    expect(await shell.listWaiting()).toEqual([unreadHost(HOST, HOST, "unreachable")]);
  });

  it("says an answer the host may have taken may have been pressed, and never sends it again", async () => {
    const session = failing("OUTCOME_UNKNOWN");
    const { client: shell, release } = clientOver(session);
    await expect(
      shell.answer({
        hostId: HOST,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("may have been pressed") });
    expect(session.call).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("says nothing was pressed for an answer that never left this machine", async () => {
    const { client: shell, release } = clientOver(failing("HOST_DISCONNECTED"));
    await expect(
      shell.answer({
        hostId: HOST,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: `${HOST} isn't connected. Nothing was pressed.` });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("claims nothing about keys when the host failed in a way it didn't explain", async () => {
    const { client: shell } = clientOver(failing("INTERNAL"));
    await expect(
      shell.answer({
        hostId: HOST,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      })
    ).rejects.toMatchObject({ userMessage: expect.not.stringContaining("Nothing was pressed") });
  });
});
