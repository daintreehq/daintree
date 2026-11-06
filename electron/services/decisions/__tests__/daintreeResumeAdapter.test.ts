import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pickResumeAdapter,
  targetOf,
  type AgentResumeAdapter,
  type LocalStore,
  type QuestionOrigin,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import { events } from "../../events.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import type { NotifyTerminalInfo } from "../../mcp-server/terminalNotify.js";
import {
  waitForAgentAtPrompt,
  type AgentPromptWaitResult,
} from "../../viewless/agentPromptWait.js";
import type {
  AgentSessionPaneRequest,
  AgentSessionPaneResult,
} from "../../viewless/viewlessAgentResume.js";
import {
  DaintreeResume,
  RESUME_PROMPT_TIMEOUT_MS,
  withResumeReasons,
  type SessionResumeDeps,
} from "../daintreeResumeAdapter.js";

/** Agents whose registry entry a test has stripped of its by-id resume. */
const registry = vi.hoisted(() => ({ withoutResume: new Set<string>() }));

vi.mock("../../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    getEffectiveAgentConfig: (id: string) => {
      const config = actual.getEffectiveAgentConfig(id);
      return config && registry.withoutResume.has(id) ? { ...config, resume: undefined } : config;
    },
  };
});

const HOST = "host-own-01";
const NEW_PANE = "terminal-resumed-1";

const ORIGIN: QuestionOrigin = {
  host_id: HOST,
  pane_id: "pane-gone",
  terminal_generation: 7,
  ownership_principal: "principal-old",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: "session-1",
  project_id: "project-1",
  worktree_id: "wt-1",
  worktree_root: "/repo/wt-1",
  workflow_gate_id: null,
};

type LaunchRecord = Omit<AgentSessionPaneRequest, "signal">;

/** The run a launch of `request` starts, as the pty host records it. */
function runFor(
  request: Pick<AgentSessionPaneRequest, "projectId" | "worktreeId" | "agentId"> & {
    sessionId: string | null | undefined;
  },
  over: Partial<NotifyTerminalInfo> = {}
): NotifyTerminalInfo {
  return {
    projectId: request.projectId,
    agentState: "working",
    launchAgentId: request.agentId,
    hasPty: true,
    launchGeneration: 1,
    agentIncarnation: 0,
    agentSessionId: request.sessionId ?? undefined,
    worktreeId: request.worktreeId,
    ...over,
  };
}

interface World {
  terminals: Map<string, NotifyTerminalInfo>;
  generations: Map<string, number>;
  principals: Map<string, string>;
}

/** A fake #16000 launch: it opens a pane holding the session, or answers as told. */
class FakeLauncher {
  readonly requests: LaunchRecord[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  /** Held until a test lets the launch finish. */
  gate: Promise<void> | null = null;
  answer: (request: AgentSessionPaneRequest) => AgentSessionPaneResult = (request) => ({
    status: "launched",
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    terminalId: NEW_PANE,
    cwd: request.cwd ?? "",
    savedInLayout: true,
  });

  constructor(private readonly world: World) {}

  async resumeSession(request: AgentSessionPaneRequest): Promise<AgentSessionPaneResult> {
    const { signal, ...rest } = request;
    this.requests.push(rest);
    this.signals.push(signal);
    if (this.gate) await this.gate;
    const result = this.answer(request);
    if (result.status === "launched") {
      this.world.terminals.set(result.terminalId, runFor(request));
      this.world.generations.set(result.terminalId, 1);
      this.world.principals.set(result.terminalId, "principal-new");
    }
    return result;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(
  options: {
    directories?: string[];
    isDirectory?: (path: string) => Promise<boolean>;
    wait?: SessionResumeDeps["waitForPrompt"];
  } = {}
) {
  const world: World = { terminals: new Map(), generations: new Map(), principals: new Map() };
  const launcher = new FakeLauncher(world);
  const controller = new AbortController();
  const host = { id: HOST as string | null, reachable: true };
  const directories = new Set(options.directories ?? ["/repo/wt-1", "/repo/wt-2/sub"]);
  const waits: Array<{ terminalId: string; timeoutMs: number; promptOnly: boolean }> = [];
  const client = {
    getTerminalAsync: async (id: string) => {
      const info = world.terminals.get(id);
      return info === undefined ? null : { ...info };
    },
    getLiveGeneration: (id: string) => world.generations.get(id) ?? null,
    isLiveGeneration: (id: string, generation: number) => world.generations.get(id) === generation,
  };
  const resume = new DaintreeResume({
    hostId: () => host.id,
    principalFor: (paneId) => world.principals.get(paneId) ?? null,
    getPtyClient: () => (host.reachable ? client : null),
    resumeSession: (request) => launcher.resumeSession(request),
    waitForPrompt: async (terminalId, waitOptions) => {
      waits.push({
        terminalId,
        timeoutMs: waitOptions.timeoutMs,
        promptOnly: waitOptions.promptOnly,
      });
      if (options.wait) return options.wait(terminalId, waitOptions);
      const info = world.terminals.get(terminalId);
      if (info) world.terminals.set(terminalId, { ...info, agentState: "waiting" });
      return { terminalId, outcome: "settled", state: "waiting", waitingReason: "prompt" };
    },
    isDirectory: options.isDirectory ?? (async (path) => directories.has(path)),
    signal: controller.signal,
  });
  const adapterFor = (origin: QuestionOrigin): AgentResumeAdapter => {
    const adapter = pickResumeAdapter(resume.adapters, origin);
    if (!adapter) throw new Error(`no adapter for ${origin.agent_kind}`);
    return adapter;
  };
  /** The engine's sequence for an origin whose run is gone. */
  const tryResume = async (origin: QuestionOrigin) => {
    const adapter = adapterFor(origin);
    const probe = await adapter.probe(origin.host_id);
    if (!probe.supported || !(await adapter.canResume(origin))) return null;
    return adapter.resume(origin);
  };
  /** A run already holding the session, which the launch hands back instead of starting one. */
  const existing = (
    terminalId: string,
    generation: number,
    over: Partial<NotifyTerminalInfo> = {}
  ) => {
    world.terminals.set(
      terminalId,
      runFor(
        { projectId: "project-1", worktreeId: "wt-1", agentId: "claude", sessionId: "session-1" },
        { launchGeneration: generation, ...over }
      )
    );
    world.generations.set(terminalId, generation);
    world.principals.set(terminalId, `principal-${terminalId}-${generation}`);
    launcher.answer = (request) => ({
      status: "existing",
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      terminalId,
    });
  };
  return { world, launcher, controller, host, waits, resume, adapterFor, tryResume, existing };
}

const settledAtPrompt = (terminalId: string): AgentPromptWaitResult => ({
  terminalId,
  outcome: "settled",
  state: "waiting",
  waitingReason: "prompt",
});

beforeEach(() => {
  registry.withoutResume.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DaintreeResume", () => {
  it.each(["claude", "codex"])(
    "reopens a %s session in its worktree, waits for its prompt and hands back the new run",
    async (kind) => {
      const h = setup();
      const origin: QuestionOrigin = {
        ...ORIGIN,
        agent_kind: kind,
        agent_session_id: "0190f0aa-session-b",
        project_id: "project-2",
        worktree_id: "wt-2",
        worktree_root: "/repo/wt-2/sub",
      };

      const resumed = await h.tryResume(origin);

      expect(h.launcher.requests).toEqual([
        {
          projectId: "project-2",
          worktreeId: "wt-2",
          agentId: kind,
          sessionId: "0190f0aa-session-b",
          cwd: "/repo/wt-2/sub",
        },
      ]);
      expect(h.launcher.signals).toEqual([h.controller.signal]);
      expect(h.waits).toEqual([
        { terminalId: NEW_PANE, timeoutMs: RESUME_PROMPT_TIMEOUT_MS, promptOnly: true },
      ]);
      expect(resumed).toEqual({
        ready: true,
        target: {
          hostId: HOST,
          paneId: NEW_PANE,
          terminalGeneration: 1,
          ownershipPrincipal: "principal-new",
          agentIncarnation: "0",
          agentSessionId: "0190f0aa-session-b",
          worktreeId: "wt-2",
        },
      });
      expect(h.resume.reasonFor(origin)).toBeNull();
    }
  );

  it("never launches for a question asked with no session id, and says so", async () => {
    const h = setup();
    for (const session of [null, "", "  "]) {
      const origin = { ...ORIGIN, agent_session_id: session };
      expect(await h.tryResume(origin)).toBeNull();
      expect(h.resume.reasonFor(origin)).toBe("resume_no_session");
    }
    expect(h.launcher.requests).toEqual([]);
  });

  it.each([
    ["its directory is gone", {}, {}, "resume_worktree_gone"],
    [
      "its directory can't be read",
      {
        isDirectory: async () => {
          throw new Error("EACCES");
        },
      },
      {},
      "resume_worktree_gone",
    ],
    ["the pane was in no worktree", {}, { worktree_id: "" }, "resume_no_worktree"],
    ["no directory was recorded", {}, { worktree_root: " " }, "resume_no_worktree"],
    ["no project was recorded", {}, { project_id: "" }, "resume_no_worktree"],
  ] as const)("never launches when %s, and says so", async (_label, options, over, reason) => {
    const h = setup({ directories: [], ...options });
    const origin = { ...ORIGIN, ...over };
    expect(await h.tryResume(origin)).toBeNull();
    expect(h.resume.reasonFor(origin)).toBe(reason);
    expect(h.launcher.requests).toEqual([]);
  });

  it("reports a supported agent whose registry entry can't reopen by id unsupported", async () => {
    registry.withoutResume.add("claude");
    const h = setup();
    expect(await h.tryResume(ORIGIN)).toBeNull();
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_unsupported_agent");
    expect(h.launcher.requests).toEqual([]);
  });

  it("reports a resume that never reaches its prompt in time, leaving its pane running", async () => {
    const h = setup({
      wait: async (terminalId) => ({ terminalId, outcome: "timeout", state: "working" }),
    });

    const resumed = await h.tryResume(ORIGIN);

    expect(resumed).toEqual({ ready: false, target: targetOf(ORIGIN) });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_timeout");
    expect(h.world.terminals.has(NEW_PANE)).toBe(true);
  });

  it("gives a launched agent a bounded wait for its prompt, and no longer", async () => {
    vi.useFakeTimers();
    getAgentAvailabilityStore();
    const entered = deferred();
    const h = setup({
      wait: (terminalId, options) => {
        const waiting = waitForAgentAtPrompt(terminalId, options);
        entered.resolve();
        return waiting;
      },
    });

    const resuming = h.tryResume(ORIGIN);
    await entered.promise;
    events.emit("agent:spawned", {
      agentId: "claude",
      terminalId: NEW_PANE,
      timestamp: Date.now(),
    });
    // A startup approval on screen is not the prompt.
    events.emit("agent:state-changed", {
      agentId: "claude",
      terminalId: NEW_PANE,
      state: "waiting",
      previousState: "working",
      waitingReason: "approval",
      trigger: "output",
      confidence: 1,
      timestamp: Date.now(),
    });
    let done = false;
    void resuming.then(() => {
      done = true;
    });

    expect(RESUME_PROMPT_TIMEOUT_MS).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(RESUME_PROMPT_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resuming).resolves.toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["exited", "resume_exited"],
    ["closed", "resume_closed"],
  ] as const)("reports a resumed agent that %s before its prompt", async (outcome, reason) => {
    const h = setup({ wait: async (terminalId) => ({ terminalId, outcome }) });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe(reason);
  });

  it("takes a wait that fails as a failed resume", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = setup({
      wait: async () => {
        throw new Error("no store");
      },
    });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_failed");
  });

  it("takes a pane already holding the session as it is, without waiting on its turn", async () => {
    const h = setup();
    h.existing("pane-live", 3);

    const resumed = await h.tryResume(ORIGIN);

    expect(h.waits).toEqual([]);
    expect(resumed).toEqual({
      ready: true,
      target: {
        hostId: HOST,
        paneId: "pane-live",
        terminalGeneration: 3,
        ownershipPrincipal: "principal-pane-live-3",
        agentIncarnation: "0",
        agentSessionId: "session-1",
        worktreeId: "wt-1",
      },
    });
  });

  it("hands every question from a restarted pane's earlier run to the run holding its session now", async () => {
    const h = setup();
    // The asking pane came back under the same id, at a new generation, with the same session.
    h.existing(ORIGIN.pane_id, 8);

    const first = await h.tryResume(ORIGIN);
    const second = await h.tryResume({ ...ORIGIN });
    h.resume.endPass();
    const later = await h.tryResume({ ...ORIGIN });

    for (const resumed of [first, second, later]) {
      expect(resumed).toMatchObject({
        ready: true,
        target: { paneId: ORIGIN.pane_id, terminalGeneration: 8 },
      });
    }
    expect(h.resume.reasonFor(ORIGIN)).toBeNull();
  });

  it.each([
    [
      "restarted in the pane",
      (h: ReturnType<typeof setup>) => {
        h.world.generations.set(NEW_PANE, 2);
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          launchGeneration: 2,
        });
      },
    ],
    [
      "gained a new owner",
      (h: ReturnType<typeof setup>) => h.world.principals.set(NEW_PANE, "principal-other"),
    ],
    [
      "started its agent again",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          agentIncarnation: 1,
        }),
    ],
    [
      "turned out to be another agent",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          detectedAgentId: "codex",
        }),
    ],
    [
      "moved to another conversation",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          agentSessionId: "session-2",
        }),
    ],
  ] as const)("refuses a run that %s while it was waited for", async (_label, change) => {
    const h = setup({
      wait: async (terminalId) => {
        change(h);
        return settledAtPrompt(terminalId);
      },
    });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_target_changed");
  });

  it.each([
    [
      "isn't the live generation",
      (h: ReturnType<typeof setup>) => h.world.generations.delete(NEW_PANE),
      "resume_host_unreadable",
    ],
    [
      "has exited",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, { ...h.world.terminals.get(NEW_PANE)!, isExited: true }),
      "resume_closed",
    ],
    [
      "is in the trash",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, { ...h.world.terminals.get(NEW_PANE)!, isTrashed: true }),
      "resume_closed",
    ],
    [
      "has no incarnation on record",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          agentIncarnation: undefined,
        }),
      "resume_target_changed",
    ],
    [
      "belongs to another project",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, { ...h.world.terminals.get(NEW_PANE)!, projectId: "p-9" }),
      "resume_target_changed",
    ],
    [
      "sits in another worktree",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, {
          ...h.world.terminals.get(NEW_PANE)!,
          worktreeId: "wt-9",
        }),
      "resume_other_worktree",
    ],
    [
      "holds no bearer",
      (h: ReturnType<typeof setup>) => h.world.principals.delete(NEW_PANE),
      "resume_no_bearer",
    ],
  ] as const)(
    "never waits on a launched run that %s when first read",
    async (_label, change, reason) => {
      const h = setup();
      const launch = h.launcher.resumeSession.bind(h.launcher);
      h.launcher.resumeSession = async (request) => {
        const result = await launch(request);
        change(h);
        return result;
      };
      expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
      expect(h.resume.reasonFor(ORIGIN)).toBe(reason);
      expect(h.waits).toEqual([]);
    }
  );

  it.each([
    ["another worktree", { worktreeId: "wt-9" }],
    ["another project", { projectId: "project-9" }],
  ] as const)("refuses a launch that reports %s", async (_label, over) => {
    const h = setup();
    const answer = h.launcher.answer;
    h.launcher.answer = (request) => ({ ...answer(request), ...over }) as AgentSessionPaneResult;
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_other_worktree");
    expect(h.waits).toEqual([]);
  });

  it.each([
    ["no-session-id", "resume_no_session"],
    ["unknown-agent", "resume_unsupported_agent"],
    ["no-resume-support", "resume_unsupported_agent"],
    ["unknown-project", "resume_unknown_project"],
    ["history-unavailable", "resume_host_unreadable"],
    ["worktrees-unavailable", "resume_host_unreadable"],
    ["terminals-unavailable", "resume_host_unreadable"],
    ["worktree-gone", "resume_worktree_gone"],
    ["other-worktree", "resume_other_worktree"],
    ["panel-limit", "resume_panel_limit"],
    ["missing-cli", "resume_missing_cli"],
    ["spawn-failed", "resume_spawn_failed"],
  ] as const)("names the launch's refusal %s", async (refusal, reason) => {
    const h = setup();
    h.launcher.answer = () => ({ status: "refused", reason: refusal, message: "refused" });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe(reason);
    expect(h.waits).toEqual([]);
  });

  it("takes a launch that throws as a failed resume, never as the pass's error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = setup();
    h.launcher.answer = () => {
      throw new Error("boom");
    };
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_failed");
  });

  it("reports other agents unsupported, with a reason, and launches nothing", async () => {
    const h = setup();
    const gemini = { ...ORIGIN, agent_kind: "gemini" };
    const probe = await h.adapterFor(gemini).probe(HOST);
    expect(probe.supported).toBe(false);
    expect(probe.reason).toMatch(/gemini/);
    expect(h.resume.reasonFor(gemini)).toBe("resume_unsupported_agent");

    // An agent the registry doesn't know has no adapter at all, and the same reason.
    const unknown = { ...ORIGIN, agent_kind: "made-up-agent" };
    expect(pickResumeAdapter(h.resume.adapters, unknown)).toBeUndefined();
    expect(h.resume.reasonFor(unknown)).toBe("resume_unsupported_agent");
    expect(h.launcher.requests).toEqual([]);
  });

  it("resumes only for a question this machine asked, while its terminal host answers", async () => {
    const h = setup();
    const elsewhere = { ...ORIGIN, host_id: "host-other" };
    expect(await h.tryResume(elsewhere)).toBeNull();
    expect(h.resume.reasonFor(elsewhere)).toBe("resume_other_host");

    h.host.reachable = false;
    expect(await h.tryResume(ORIGIN)).toBeNull();
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_host_unreachable");
    expect(h.launcher.requests).toEqual([]);
  });

  it("resumes a run once per pass for all its questions, and afresh in the next pass", async () => {
    const h = setup({
      wait: async (terminalId) => ({ terminalId, outcome: "timeout", state: "working" }),
    });
    await h.tryResume(ORIGIN);
    await h.tryResume({ ...ORIGIN });
    expect(h.launcher.requests).toHaveLength(1);
    expect(h.waits).toHaveLength(1);

    h.resume.endPass();
    expect(h.resume.reasonFor(ORIGIN)).toBeNull();
    await h.tryResume(ORIGIN);
    expect(h.launcher.requests).toHaveLength(2);
  });

  it("never shares a resume, or its reason, between different runs of one pane", async () => {
    const h = setup({
      wait: async (terminalId) => ({ terminalId, outcome: "timeout", state: "working" }),
    });
    const others: QuestionOrigin[] = [
      { ...ORIGIN, terminal_generation: 8 },
      { ...ORIGIN, ownership_principal: "principal-other" },
      { ...ORIGIN, agent_incarnation: "1" },
      { ...ORIGIN, agent_session_id: "session-2" },
    ];
    await h.tryResume(ORIGIN);
    for (const origin of others) await h.tryResume(origin);
    expect(h.launcher.requests).toHaveLength(1 + others.length);

    // A run whose resume nothing refused keeps the library's own code.
    const untried = { ...ORIGIN, terminal_generation: 9 };
    expect(h.resume.reasonFor(untried)).toBeNull();
  });

  it("never resumes again a run it resumed into once that run has gone", async () => {
    const h = setup();
    const first = await h.tryResume(ORIGIN);
    h.resume.endPass();
    // The library moved the question to the resumed run, which someone closed.
    const target = first!.target;
    h.world.terminals.delete(target.paneId);
    h.world.generations.delete(target.paneId);
    const moved: QuestionOrigin = {
      ...ORIGIN,
      pane_id: target.paneId,
      terminal_generation: target.terminalGeneration,
      ownership_principal: target.ownershipPrincipal,
      agent_incarnation: target.agentIncarnation,
    };

    expect(await h.tryResume(moved)).toBeNull();
    expect(h.resume.reasonFor(moved)).toBe("resume_ended");
    expect(h.launcher.requests).toHaveLength(1);
  });

  it("throws when delivery stops during the wait, so nothing is recorded", async () => {
    const entered = deferred();
    const h = setup({
      wait: (terminalId, options) => {
        entered.resolve();
        return new Promise((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({ terminalId, outcome: "aborted" })
          )
        );
      },
    });
    const resuming = h.tryResume(ORIGIN);
    await entered.promise;
    h.controller.abort();

    await expect(resuming).rejects.toMatchObject({ name: "AbortError" });
    expect(h.resume.reasonFor(ORIGIN)).toBeNull();
    // A later attempt in the same stopped lifetime throws too, launching nothing.
    await expect(h.tryResume({ ...ORIGIN, pane_id: "pane-other" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.launcher.requests).toHaveLength(1);
  });

  it("hands the launch the stop signal, and throws without waiting once it returns after a stop", async () => {
    const h = setup();
    const gate = deferred();
    const entered = deferred();
    h.launcher.gate = gate.promise;
    const launch = h.launcher.resumeSession.bind(h.launcher);
    h.launcher.resumeSession = (request) => {
      const launching = launch(request);
      entered.resolve();
      return launching;
    };
    const resuming = h.tryResume(ORIGIN);
    await entered.promise;

    h.controller.abort();
    expect(h.launcher.signals[0]?.aborted).toBe(true);
    gate.resolve();

    await expect(resuming).rejects.toMatchObject({ name: "AbortError" });
    expect(h.waits).toEqual([]);
  });
});

describe("withResumeReasons", () => {
  function storeWith(rows: QuestionRow[]) {
    const byId = new Map(rows.map((row) => [row.question_id, row]));
    const updates: Array<[string, Partial<QuestionRow>]> = [];
    const store = {
      getQuestion: async (id: string) => byId.get(id) ?? null,
      updateQuestion: async (id: string, patch: Partial<QuestionRow>) => {
        updates.push([id, patch]);
      },
      listQuestions: async () => [...byId.values()],
    } as unknown as LocalStore;
    return { store, updates };
  }

  const row = (id: string, origin: QuestionOrigin) => ({ question_id: id, origin }) as QuestionRow;

  it.each(["pane_gone", "relaunched", "generation_mismatch", "session_mismatch"])(
    "records the resume's own reason in place of the library's %s",
    async (code) => {
      const h = setup({ directories: [] });
      const { store, updates } = storeWith([row("q1", ORIGIN)]);
      await h.tryResume(ORIGIN);

      await withResumeReasons(store, h.resume).updateQuestion("q1", {
        delivery_status: "needs-attention",
        error_code: code,
      });

      expect(updates).toEqual([
        ["q1", { delivery_status: "needs-attention", error_code: "resume_worktree_gone" }],
      ]);
    }
  );

  it("touches only that run's attention write, and only the library's resumable codes", async () => {
    const h = setup({ directories: [] });
    const other = { ...ORIGIN, pane_id: "pane-other", agent_kind: "codex" };
    const { store, updates } = storeWith([row("q1", ORIGIN), row("q2", other)]);
    const wrapped = withResumeReasons(store, h.resume);
    await h.tryResume(ORIGIN);

    // Nothing refused this run's resume, so its generic code stands.
    await wrapped.updateQuestion("q2", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    await wrapped.updateQuestion("q1", {
      delivery_status: "needs-attention",
      error_code: "resume_wrong_worktree",
    });
    await wrapped.updateQuestion("q1", {
      delivery_status: "delivery-uncertain",
      error_code: "pane_gone",
    });

    expect(updates).toEqual([
      ["q2", { delivery_status: "needs-attention", error_code: "pane_gone" }],
      ["q1", { delivery_status: "needs-attention", error_code: "resume_wrong_worktree" }],
      ["q1", { delivery_status: "delivery-uncertain", error_code: "pane_gone" }],
    ]);
  });

  it("forgets a pass's reasons, its probes' too, when the pass ends", async () => {
    const h = setup({ directories: [] });
    const unknown = { ...ORIGIN, pane_id: "pane-unknown", agent_kind: "made-up-agent" };
    const { store, updates } = storeWith([row("q1", ORIGIN), row("q2", unknown)]);
    const wrapped = withResumeReasons(store, h.resume);
    await h.tryResume(ORIGIN);
    h.host.reachable = false;
    await h.tryResume({ ...ORIGIN, agent_kind: "codex" });
    h.resume.endPass();
    h.host.reachable = true;

    await wrapped.updateQuestion("q1", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    expect(h.resume.reasonFor({ ...ORIGIN, agent_kind: "codex" })).toBeNull();
    // An agent with no adapter at all is unsupported in every pass.
    await wrapped.updateQuestion("q2", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    expect(updates).toEqual([
      ["q1", { delivery_status: "needs-attention", error_code: "pane_gone" }],
      ["q2", { delivery_status: "needs-attention", error_code: "resume_unsupported_agent" }],
    ]);
  });
});
