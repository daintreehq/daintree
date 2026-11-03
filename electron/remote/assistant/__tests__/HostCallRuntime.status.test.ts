import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";
import {
  HostStatusResultSchema,
  type HostStatusResult,
} from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import type {
  McpCallAnswer,
  ProjectStatusAnswer,
  RelayCallRequest,
  StatusAnswer,
  StatusPayload,
} from "../linkMethods.js";
import { fitHostStatus, HOST_STATUS_READ_MS } from "../hostStatus.js";

const GITHUB_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2";

function observed(hostId: string): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
  } as ObservedHost;
}

function entry(terminalId: string, extra: Record<string, unknown> = {}) {
  return {
    terminalId,
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastTransitionAt: 10,
    ...extra,
  };
}

function done(projectId: string, terminals: ReturnType<typeof entry>[]): ProjectStatusAnswer {
  return {
    status: "done",
    projectId,
    result: { terminals, source: "pty", unavailableFields: ["armed"] },
    complete: true,
    omitted: 0,
  };
}

/** A host's whole answer: every project it was asked about, read as `read` says. */
function answering(read: (projectId: string) => ProjectStatusAnswer) {
  return async (_hostId: string, payload: Omit<StatusPayload, "runMs">): Promise<StatusAnswer> => ({
    status: "done",
    projects: payload.projects.map(({ projectId }) => read(projectId)),
  });
}

type StatusFn = (
  hostId: string,
  payload: Omit<StatusPayload, "runMs">,
  timeoutMs: number
) => Promise<StatusAnswer>;

function setup(
  options: {
    caller?: string;
    control?: (hostId: string) => boolean;
    status?: StatusFn;
    relayCall?: (hostId: string, request: RelayCallRequest) => Promise<McpCallAnswer>;
    agents?: (hostId: string, payload: { projectId?: string }) => Promise<unknown>;
    localStatus?: (payload: StatusPayload) => Promise<ProjectStatusAnswer[]>;
  } = {}
) {
  const callerProject = options.caller ?? GLOBAL_ASSISTANT_ID;
  const run: OpenRun = {
    projectId: callerProject,
    slot: 0,
    sessionId: "a",
    terminalId: "t-a",
    launchGeneration: 1,
  };
  const status = vi.fn(options.status ?? answering((projectId) => done(projectId, [])));
  const relayCall = vi.fn(
    options.relayCall ??
      (async (): Promise<McpCallAnswer> => ({ status: "refused", reason: "server-off" }))
  );
  const agents = vi.fn(
    options.agents ?? (async () => ({ status: "refused", reason: "control-off" }))
  );
  const localStatus = vi.fn(
    options.localStatus ??
      (async (payload: StatusPayload) =>
        payload.projects.map(({ projectId }) => done(projectId, [entry(`${projectId}-t`)])))
  );
  const runtime = new HostCallRuntime({
    getSessionLane: (id) => (id === "a" ? { projectId: callerProject, slot: 0 } : null),
    callerRun: (id) => (id === "a" ? run : null),
    client: () =>
      ({
        relayCall,
        throwawayCall: vi.fn(),
        status,
        agents,
      }) as never,
    hosts: () => [observed("studio"), observed("mini")],
    inLocalView: () => true,
    controlEnabled: options.control ?? (() => true),
    local: {
      name: () => "this-mac",
      projects: async () => [],
      relayCall: vi.fn(),
      status: localStatus,
    },
  });
  return { runtime, status, relayCall, agents, localStatus };
}

async function read(
  runtime: HostCallRuntime,
  args: Parameters<HostCallRuntime["status"]>[1]
): Promise<HostStatusResult> {
  const outcome = await runtime.status("a", args, { tier: "core" });
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  // What the tool advertises is what it answers.
  expect(HostStatusResultSchema.parse(outcome.value)).toEqual(outcome.value);
  return outcome.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HostCallRuntime host.status (#16191)", () => {
  it("reads every host at once, one exchange each, and lists every terminal with where it runs", async () => {
    let releaseStudio: () => void = () => {};
    const studioHeld = new Promise<void>((resolve) => {
      releaseStudio = resolve;
    });
    const { runtime, status, localStatus } = setup({
      status: async (hostId, payload) => {
        if (hostId === "studio") await studioHeld;
        return answering((projectId) => done(projectId, [entry(`${hostId}-${projectId}`)]))(
          hostId,
          payload
        );
      },
    });
    const pending = read(runtime, {
      targets: [
        { hostId: "studio", projectId: "p1" },
        { hostId: "mini", projectId: "p3", terminalIds: ["m-1"] },
        { hostId: "studio", projectId: "p2", terminalIds: ["s-1", "s-2"] },
        { hostId: "local", projectId: "p4" },
      ],
      includeOutput: true,
    });
    // mini is asked while studio still hasn't answered: no host waits on another.
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    releaseStudio();
    const result = await pending;

    expect(status).toHaveBeenCalledWith(
      "studio",
      {
        helpSessionId: "a",
        tier: "core",
        global: true,
        projects: [{ projectId: "p1" }, { projectId: "p2", terminalIds: ["s-1", "s-2"] }],
        // `true` reads as this tool's own default, not a single project's.
        includeOutput: { lines: 10, stripAnsi: true },
      },
      HOST_STATUS_READ_MS
    );
    expect(localStatus).toHaveBeenCalledTimes(1);
    expect(localStatus.mock.calls[0]![0]).toMatchObject({ projects: [{ projectId: "p4" }] });
    expect(result.hosts).toEqual([
      { hostId: "studio", coverage: "ok" },
      { hostId: "mini", coverage: "ok" },
      { hostId: "local", coverage: "ok" },
    ]);
    expect(
      result.targets.map((target) => [target.hostId, target.projectId, target.outcome])
    ).toEqual([
      ["studio", "p1", "ok"],
      ["mini", "p3", "ok"],
      ["studio", "p2", "ok"],
      ["local", "p4", "ok"],
    ]);
    expect(
      result.terminals.map(({ hostId, projectId, terminalId }) => [hostId, projectId, terminalId])
    ).toEqual([
      ["studio", "p1", "studio-p1"],
      ["mini", "p3", "mini-p3"],
      ["studio", "p2", "studio-p2"],
      ["local", "p4", "p4-t"],
    ]);
    expect(result.targets[0]).toMatchObject({
      source: "pty",
      unavailableFields: ["armed"],
      complete: true,
    });
    runtime.dispose();
  });

  it("holds each host to its own gates, and the caller's own project to itself", async () => {
    const { runtime, status, localStatus } = setup({
      caller: "own",
      control: (hostId) => hostId !== "mini",
    });
    const result = await read(runtime, {
      targets: [
        { hostId: "nowhere", projectId: "p1" },
        { hostId: "mini", projectId: "p2" },
        { hostId: "local", projectId: "own" },
        { hostId: "local", projectId: "other" },
        { hostId: "studio", projectId: "p3" },
      ],
    });
    expect(result.targets.map((target) => target.outcome)).toEqual([
      "not_found",
      "opted_out",
      "policy_rejected",
      "ok",
      "ok",
    ]);
    // Control off here: the host is never asked.
    expect(status.mock.calls.map(([hostId]) => hostId)).toEqual(["studio"]);
    // A project assistant's own project is read directly, never through here.
    expect(localStatus.mock.calls[0]![0].projects).toEqual([{ projectId: "other" }]);
    expect(status.mock.calls[0]![1]).not.toHaveProperty("global");
    expect(result.hosts).toEqual([
      { hostId: "nowhere", coverage: "unreachable" },
      { hostId: "mini", coverage: "unreachable" },
      { hostId: "local", coverage: "ok" },
      { hostId: "studio", coverage: "ok" },
    ]);
    runtime.dispose();
  });

  it("says in fixed words how each host's read went, never what the host said", async () => {
    const answers: Record<string, () => Promise<StatusAnswer>> = {
      studio: async () => ({ status: "refused", reason: "control-off" }),
      mini: async () => {
        throw new AppError({ code: "HOST_DISCONNECTED", message: "secret words from the link" });
      },
    };
    const { runtime } = setup({ status: (hostId) => answers[hostId]!() });
    const result = await read(runtime, {
      targets: [
        { hostId: "studio", projectId: "p1" },
        { hostId: "mini", projectId: "p2" },
      ],
    });
    expect(result.targets.map((target) => target.outcome)).toEqual([
      "policy_rejected",
      "disconnected",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret words");
    expect(result.hosts.map((host) => host.coverage)).toEqual(["unreachable", "unreachable"]);
    runtime.dispose();
  });

  it("answers a host that hasn't answered within its time as expired, and the others as read", async () => {
    vi.useFakeTimers();
    const { runtime } = setup({
      status: (hostId, payload) =>
        hostId === "studio"
          ? new Promise<StatusAnswer>(() => {})
          : answering((projectId) => done(projectId, [entry("m-1")]))(hostId, payload),
    });
    const pending = runtime.status(
      "a",
      {
        targets: [
          { hostId: "studio", projectId: "p1" },
          { hostId: "mini", projectId: "p2" },
        ],
      },
      { tier: "core" }
    );
    await vi.advanceTimersByTimeAsync(HOST_STATUS_READ_MS);
    const outcome = await pending;
    expect(outcome.ok && outcome.value.targets.map((target) => target.outcome)).toEqual([
      "expired",
      "ok",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    runtime.dispose();
  });

  it("shows nothing read of a host whose control went off while it was read", async () => {
    let control = true;
    const { runtime } = setup({
      control: () => control,
      status: async (hostId, payload) => {
        control = false;
        return answering((projectId) => done(projectId, [entry("s-1")]))(hostId, payload);
      },
    });
    const result = await read(runtime, { targets: [{ hostId: "studio", projectId: "p1" }] });
    expect(result.targets[0]!.outcome).toBe("opted_out");
    expect(result.terminals).toEqual([]);
    runtime.dispose();
  });

  it("reads an older host project by project, as host.call would, and redacts what comes back", async () => {
    const relayCall = vi.fn(async (_hostId: string, request: RelayCallRequest) => {
      const result = {
        terminals: (request.args.terminalIds as string[]).map((terminalId) =>
          entry(terminalId, { recentOutput: `token ${GITHUB_TOKEN}` })
        ),
        source: "renderer",
        unavailableFields: [],
      };
      return {
        status: "done" as const,
        result: { isError: false, structured: result, text: null },
      };
    });
    const agents = vi.fn(async (_hostId: string, payload: { projectId?: string }) => ({
      status: "done",
      directory: {
        coverage: "ok",
        observedAt: 1,
        complete: true,
        omitted: 0,
        entries: [
          {
            state: "live",
            role: "worker",
            subject: {
              hostId: "local",
              scope: { kind: "project", projectId: payload.projectId },
              terminalId: "w-1",
              incarnation: 1,
            },
            agentId: "claude",
            agentState: "idle",
            waitingReason: null,
            since: null,
            label: null,
            attached: null,
            handback: null,
          },
        ],
      },
    }));
    const { runtime, status } = setup({
      status: async () => {
        throw new AppError({ code: "UNSUPPORTED", message: "no such method" });
      },
      relayCall,
      agents,
    });
    const result = await read(runtime, {
      targets: [
        { hostId: "studio", projectId: "p1", terminalIds: ["s-1"] },
        { hostId: "studio", projectId: "p2" },
      ],
      includeOutput: { lines: 4, stripAnsi: true },
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(relayCall).toHaveBeenCalledTimes(2);
    for (const [hostId, request] of relayCall.mock.calls) {
      expect(hostId).toBe("studio");
      expect(request).toMatchObject({
        helpSessionId: "a",
        tier: "core",
        resend: false,
        tool: "terminal.getStatus",
        global: true,
        args: { includeOutput: { lines: 4, stripAnsi: true } },
      });
    }
    // Each first send gets its own callId.
    expect(new Set(relayCall.mock.calls.map(([, request]) => request.callId)).size).toBe(2);
    expect(agents).toHaveBeenCalledWith("studio", { projectId: "p2" }, expect.any(Number));
    expect(result.terminals.map((terminal) => terminal.terminalId)).toEqual(["s-1", "w-1"]);
    expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
    expect(result.terminals[0]!.recentOutput).toBe("token [redacted]");
    expect(result.hosts).toEqual([{ hostId: "studio", coverage: "ok" }]);
    runtime.dispose();
  });

  it("says a host that can run no relayed tools at all is unsupported", async () => {
    const { runtime } = setup({
      status: async () => {
        throw new AppError({ code: "UNSUPPORTED", message: "no such method" });
      },
      relayCall: async () => {
        throw new AppError({ code: "UNSUPPORTED", message: "no such method" });
      },
    });
    const result = await read(runtime, {
      targets: [{ hostId: "studio", projectId: "p1", terminalIds: ["s-1"] }],
    });
    expect(result.hosts).toEqual([{ hostId: "studio", coverage: "unsupported" }]);
    expect(result.targets[0]!.outcome).toBe("unsupported");
    runtime.dispose();
  });

  it("refuses a session that isn't one of this machine's running assistants", async () => {
    const { runtime, status } = setup();
    await expect(
      runtime.status(
        "stranger",
        { targets: [{ hostId: "studio", projectId: "p1" }] },
        { tier: "core" }
      )
    ).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(status).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("holds the host's link while it is read, and lets it go after", async () => {
    let releaseRead: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const { runtime } = setup({
      status: async (hostId, payload) => {
        await held;
        return answering((projectId) => done(projectId, []))(hostId, payload);
      },
    });
    const pending = runtime.status(
      "a",
      { targets: [{ hostId: "studio", projectId: "p1" }] },
      { tier: "core" }
    );
    await vi.waitFor(() => expect(runtime.hasCallInFlight("studio")).toBe(true));
    releaseRead();
    await pending;
    expect(runtime.hasCallInFlight("studio")).toBe(false);
    runtime.dispose();
  });
});

describe("fitHostStatus (#16191)", () => {
  const target = (hostId: string, projectId: string) => ({
    hostId,
    projectId,
    outcome: "ok" as const,
    detail: null,
    retryAfterMs: null,
    source: "pty" as const,
    unavailableFields: [],
    complete: true,
    omitted: 0,
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("shares tail room by terminal, so a host with one agent gets no more than one with twelve", () => {
    const tail = "x".repeat(20_000);
    const result: HostStatusResult = {
      hosts: [
        { hostId: "studio", coverage: "ok" },
        { hostId: "mini", coverage: "ok" },
      ],
      targets: [target("studio", "p1"), target("mini", "p2")],
      terminals: [
        { ...entry("s-1", { recentOutput: tail }), hostId: "studio", projectId: "p1" },
        ...Array.from({ length: 12 }, (_, index) => ({
          ...entry(`m-${index}`, { recentOutput: tail }),
          hostId: "mini",
          projectId: "p2",
        })),
      ],
    } as HostStatusResult;
    const fitted = fitHostStatus(result, MCP_RESPONSE_TEXT_MAX_BYTES);
    expect(bytes(fitted)).toBeLessThanOrEqual(MCP_RESPONSE_TEXT_MAX_BYTES);
    const lengths = fitted.terminals.map((terminal) => (terminal.recentOutput as string).length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    expect(fitted.terminals.every((terminal) => terminal.recentOutputTruncated === true)).toBe(
      true
    );
    // Every state is kept: only tails were cut.
    expect(fitted.terminals).toHaveLength(13);
    expect(fitted.targets.map((each) => each.omitted)).toEqual([0, 0]);
  });

  it("keeps a state-only answer whole while it fits, and counts terminals left out when it doesn't", () => {
    const handback = { message: "m".repeat(500), observedAt: 1, truncated: false };
    const make = (count: number): HostStatusResult =>
      ({
        hosts: [{ hostId: "studio", coverage: "ok" }],
        targets: [target("studio", "p1"), target("studio", "p2")],
        terminals: Array.from({ length: count }, (_, index) => ({
          ...entry(`t-${index}`, { lastHandback: handback }),
          hostId: "studio",
          projectId: index < count / 2 ? "p1" : "p2",
        })),
      }) as HostStatusResult;

    const small = make(8);
    expect(fitHostStatus(small, MCP_RESPONSE_TEXT_MAX_BYTES)).toEqual(small);

    const large = make(200);
    const fitted = fitHostStatus(large, MCP_RESPONSE_TEXT_MAX_BYTES);
    expect(bytes(fitted)).toBeLessThanOrEqual(MCP_RESPONSE_TEXT_MAX_BYTES);
    expect(fitted.terminals.length).toBeLessThan(200);
    // Nothing kept was cut: whole entries are left out, from the end, and counted.
    for (const kept of fitted.terminals) expect(kept.lastHandback?.message).toBe(handback.message);
    const omitted = fitted.targets.reduce((sum, each) => sum + each.omitted, 0);
    expect(omitted + fitted.terminals.length).toBe(200);
    expect(fitted.targets[1]).toMatchObject({ complete: false });
  });

  it("carries no more terminals than its cap, counting the rest", () => {
    const result = {
      hosts: [{ hostId: "studio", coverage: "ok" }],
      targets: [target("studio", "p1")],
      terminals: Array.from({ length: 300 }, (_, index) => ({
        terminalId: `t-${index}`,
        agentId: null,
        agentState: null,
        hostId: "studio",
        projectId: "p1",
      })),
    } as HostStatusResult;
    const fitted = fitHostStatus(result, Number.MAX_SAFE_INTEGER);
    expect(fitted.terminals).toHaveLength(256);
    expect(fitted.targets[0]).toMatchObject({ omitted: 44, complete: false });
  });
});
