import { describe, expect, it, vi } from "vitest";
import {
  pickResumeAdapter,
  targetOf,
  type AgentResumeAdapter,
  type LocalStore,
  type QuestionOrigin,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import type { NotifyTerminalInfo } from "../../mcp-server/terminalNotify.js";
import type { AgentPromptWaitResult } from "../../viewless/agentPromptWait.js";
import type {
  AgentSessionPaneRequest,
  AgentSessionPaneResult,
} from "../../viewless/viewlessAgentResume.js";
import {
  DaintreeResume,
  RESUME_PROMPT_TIMEOUT_MS,
  withResumeReasons,
} from "../daintreeResumeAdapter.js";

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

function runOf(over: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return {
    projectId: "project-1",
    agentState: "working",
    launchAgentId: "claude",
    hasPty: true,
    launchGeneration: 1,
    agentIncarnation: 0,
    agentSessionId: "session-1",
    worktreeId: "wt-1",
    ...over,
  };
}

/** A fake #16000 launch: it opens a pane holding the session, or answers as told. */
class FakeLauncher {
  readonly requests: AgentSessionPaneRequest[] = [];
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
    this.requests.push(request);
    const result = this.answer(request);
    if (result.status === "launched") {
      this.world.terminals.set(result.terminalId, runOf({ launchAgentId: request.agentId }));
      this.world.generations.set(result.terminalId, 1);
      this.world.principals.set(result.terminalId, "principal-new");
    }
    return result;
  }
}

interface World {
  terminals: Map<string, NotifyTerminalInfo>;
  generations: Map<string, number>;
  principals: Map<string, string>;
}

function setup(
  options: {
    directories?: string[];
    wait?: (terminalId: string, signal: AbortSignal) => Promise<AgentPromptWaitResult>;
  } = {}
) {
  const world: World = { terminals: new Map(), generations: new Map(), principals: new Map() };
  const launcher = new FakeLauncher(world);
  const controller = new AbortController();
  const host = { id: HOST as string | null, reachable: true };
  const directories = new Set(options.directories ?? ["/repo/wt-1", "/repo/wt-2"]);
  const waits: Array<{ terminalId: string; timeoutMs: number; promptOnly: boolean }> = [];
  const client = {
    getTerminalAsync: vi.fn(async (id: string) => {
      const info = world.terminals.get(id);
      return info === undefined ? null : { ...info };
    }),
    getLiveGeneration: (id: string) => world.generations.get(id) ?? null,
    isLiveGeneration: (id: string, generation: number) => world.generations.get(id) === generation,
  };
  const settleAtPrompt = (terminalId: string) => {
    const info = world.terminals.get(terminalId);
    if (info) world.terminals.set(terminalId, { ...info, agentState: "waiting" });
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
      if (options.wait) return options.wait(terminalId, waitOptions.signal);
      settleAtPrompt(terminalId);
      return { terminalId, outcome: "settled", state: "waiting", waitingReason: "prompt" };
    },
    isDirectory: async (path) => directories.has(path),
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
  return { world, launcher, controller, host, client, waits, resume, adapterFor, tryResume };
}

describe("DaintreeResume", () => {
  it.each(["claude", "codex"])(
    "reopens a %s session in its worktree, waits for its prompt and hands back the new run",
    async (kind) => {
      const h = setup();
      const origin = { ...ORIGIN, agent_kind: kind };

      const resumed = await h.tryResume(origin);

      expect(h.launcher.requests).toEqual([
        {
          projectId: "project-1",
          worktreeId: "wt-1",
          agentId: kind,
          sessionId: "session-1",
          cwd: "/repo/wt-1",
        },
      ]);
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
          agentSessionId: "session-1",
          worktreeId: "wt-1",
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

  it("never launches once the worktree's directory is gone, and says so", async () => {
    const h = setup({ directories: [] });
    expect(await h.tryResume(ORIGIN)).toBeNull();
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_worktree_gone");
    expect(h.launcher.requests).toEqual([]);

    const outside = { ...ORIGIN, worktree_id: "" };
    expect(await h.tryResume(outside)).toBeNull();
    expect(h.resume.reasonFor(outside)).toBe("resume_no_worktree");
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

  it.each([
    ["exited", "resume_exited"],
    ["closed", "resume_closed"],
  ] as const)("reports a resumed agent that %s before its prompt", async (outcome, reason) => {
    const h = setup({ wait: async (terminalId) => ({ terminalId, outcome }) });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe(reason);
  });

  it("takes a pane already holding the session as it is, without waiting on its turn", async () => {
    const h = setup();
    h.world.terminals.set("pane-live", runOf({ agentState: "working", launchGeneration: 3 }));
    h.world.generations.set("pane-live", 3);
    h.world.principals.set("pane-live", "principal-live");
    h.launcher.answer = (request) => ({
      status: "existing",
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      terminalId: "pane-live",
    });

    const resumed = await h.tryResume(ORIGIN);

    expect(h.waits).toEqual([]);
    expect(resumed).toMatchObject({
      ready: true,
      target: { paneId: "pane-live", terminalGeneration: 3, ownershipPrincipal: "principal-live" },
    });
  });

  it.each([
    [
      "restarted in the pane",
      (h: ReturnType<typeof setup>) => {
        h.world.generations.set(NEW_PANE, 2);
        h.world.terminals.set(NEW_PANE, runOf({ launchGeneration: 2, agentState: "waiting" }));
      },
    ],
    [
      "moved to another conversation",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, runOf({ agentSessionId: "session-2" })),
    ],
    [
      "taken over by another agent",
      (h: ReturnType<typeof setup>) =>
        h.world.terminals.set(NEW_PANE, runOf({ detectedAgentId: "gemini", agentIncarnation: 1 })),
    ],
  ] as const)("refuses a run that %s while it was waited for", async (_label, change) => {
    const h = setup({
      wait: async (terminalId) => {
        change(h);
        return { terminalId, outcome: "settled", state: "waiting", waitingReason: "prompt" };
      },
    });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_target_changed");
  });

  it("refuses a resumed pane that holds no bearer, which no answer could be tied to", async () => {
    const h = setup();
    const launch = h.launcher.resumeSession.bind(h.launcher);
    h.launcher.resumeSession = async (request) => {
      const result = await launch(request);
      h.world.principals.delete(NEW_PANE);
      return result;
    };
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe("resume_no_bearer");
    expect(h.waits).toEqual([]);
  });

  it.each([
    ["spawn-failed", "resume_spawn_failed"],
    ["worktree-gone", "resume_worktree_gone"],
    ["other-worktree", "resume_other_worktree"],
    ["terminals-unavailable", "resume_host_unreadable"],
    ["missing-cli", "resume_missing_cli"],
  ] as const)("names the launch's refusal %s", async (refusal, reason) => {
    const h = setup();
    h.launcher.answer = () => ({ status: "refused", reason: refusal, message: "refused" });
    expect(await h.tryResume(ORIGIN)).toMatchObject({ ready: false });
    expect(h.resume.reasonFor(ORIGIN)).toBe(reason);
  });

  it("takes a launch that throws as a failed resume, never as the pass's error", async () => {
    const h = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("never resumes again a run it resumed into that has gone since", async () => {
    const h = setup();
    const first = await h.tryResume(ORIGIN);
    h.resume.endPass();
    // The library moved the question to the resumed run, which someone closed.
    const moved = { ...ORIGIN, pane_id: first!.target.paneId };

    expect(await h.tryResume(moved)).toBeNull();
    expect(h.resume.reasonFor(moved)).toBe("resume_ended");
    expect(h.launcher.requests).toHaveLength(1);
  });

  it("throws when delivery stops during the wait, so nothing is recorded", async () => {
    let waitSignal: AbortSignal | undefined;
    const h = setup({
      wait: (terminalId, signal) => {
        waitSignal = signal;
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ terminalId, outcome: "aborted" }))
        );
      },
    });
    const resuming = h.tryResume(ORIGIN);
    await vi.waitFor(() => expect(waitSignal).toBeDefined());
    h.controller.abort();

    await expect(resuming).rejects.toMatchObject({ name: "AbortError" });
    expect(h.resume.reasonFor(ORIGIN)).toBeNull();
    // A later attempt in the same stopped lifetime throws too, launching nothing.
    await expect(h.tryResume({ ...ORIGIN, pane_id: "pane-other" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.launcher.requests).toHaveLength(1);
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

  it("records the resume's own reason in place of the library's generic code, for that run alone", async () => {
    const h = setup({ directories: [] });
    const other = { ...ORIGIN, pane_id: "pane-other", agent_kind: "codex" };
    const { store, updates } = storeWith([row("q1", ORIGIN), row("q2", other)]);
    const wrapped = withResumeReasons(store, h.resume);
    await h.tryResume(ORIGIN);

    await wrapped.updateQuestion("q1", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    // Nothing refused this run's resume, so its generic code stands.
    await wrapped.updateQuestion("q2", {
      delivery_status: "needs-attention",
      error_code: "relaunched",
    });
    // Codes a resume didn't decide are never touched.
    await wrapped.updateQuestion("q1", {
      delivery_status: "needs-attention",
      error_code: "resume_wrong_worktree",
    });
    await wrapped.updateQuestion("q1", {
      delivery_status: "delivery-uncertain",
      error_code: "pane_gone",
    });

    expect(updates).toEqual([
      ["q1", { delivery_status: "needs-attention", error_code: "resume_worktree_gone" }],
      ["q2", { delivery_status: "needs-attention", error_code: "relaunched" }],
      ["q1", { delivery_status: "needs-attention", error_code: "resume_wrong_worktree" }],
      ["q1", { delivery_status: "delivery-uncertain", error_code: "pane_gone" }],
    ]);
  });

  it("forgets a pass's reasons when the pass ends", async () => {
    const h = setup({ directories: [] });
    const { store, updates } = storeWith([row("q1", ORIGIN)]);
    const wrapped = withResumeReasons(store, h.resume);
    await h.tryResume(ORIGIN);
    h.resume.endPass();

    await wrapped.updateQuestion("q1", {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    expect(updates).toEqual([
      ["q1", { delivery_status: "needs-attention", error_code: "pane_gone" }],
    ]);
  });
});
