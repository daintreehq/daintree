import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_SLOTS } from "../../../../shared/config/assistantSlots.js";
import { NO_VIEW_HANDLE } from "../../../ipc/endpoint.js";
import {
  spawnAndConfirm,
  startAssistantWithoutView,
  type AssistantLaunchDeps,
  type AssistantLaunchRequest,
} from "../assistantLaunch.js";

const PROJECT = { id: "proj-1", path: "/repos/one" };
const SESSION_FOLDER =
  "/Users/me/Library/Application Support/Daintree/help-sessions/9630935fa5c2fbb7.codex";
const STARTED_BY = {
  kind: "relay",
  senderId: "sender-a",
  linkSessionId: "link-a",
  askingHelpSessionId: "hub-help-1",
} as const;
const trustScreen = [
  "> You are in /Users/me/Library/Application Support/Daintree/",
  "  help-sessions/9630935fa5c2fbb7.codex",
  "  Do you trust the contents of this directory?",
  "› 1. Yes, continue",
  "  2. No, quit",
].join("\n");
const READY_SCREEN = [
  "› Daintree started you for the hub assistant on another machine.",
  "",
  "• Ready.",
  "",
  "› Ask Codex to do anything",
].join("\n");

describe("startAssistantWithoutView (#13511, #13496)", () => {
  let clock: number;
  let screens: string[];
  let running: boolean;
  let writes: string[];
  let occupied: number[];
  let deps: AssistantLaunchDeps & {
    provision: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    clock = 0;
    screens = [READY_SCREEN];
    running = true;
    writes = [];
    occupied = [];
    deps = {
      getProject: (projectId) => (projectId === PROJECT.id ? PROJECT : null),
      occupiedSlots: () => occupied,
      launchableAgents: async () => [
        { id: "copilot", byDefault: false },
        { id: "codex", byDefault: true },
        { id: "claude", byDefault: true },
        { id: "gemini", byDefault: true },
      ],
      provision: vi.fn(async () => ({
        sessionId: "session-1",
        sessionPath: SESSION_FOLDER,
        token: "bearer-1",
        mcpUrl: "http://127.0.0.1:45454/mcp",
      })),
      revoke: vi.fn(async () => {}),
      launchFlags: async () => ["--model", "gpt-6.1"],
      spawn: vi.fn(async () => true),
      isRunning: () => running,
      serializedState: async () => ({ data: screens[0]! }),
      // A key moves the CLI on to its next screen.
      write: (_terminalId, data) => {
        writes.push(data);
        if (screens.length > 1) screens.shift();
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    } as typeof deps;
  });

  const start = (request: Partial<AssistantLaunchRequest> = {}) =>
    startAssistantWithoutView(
      { projectId: PROJECT.id, slot: 1, startedBy: STARTED_BY, ...request },
      deps
    );

  it("starts the default agent in the slot named, with no view, recording who asked", async () => {
    const result = await start();
    expect(result).toMatchObject({
      status: "started",
      sessionId: "session-1",
      slot: 1,
      agentId: "codex",
      ready: true,
      notReadyReason: null,
    });
    expect(deps.provision).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      projectPath: PROJECT.path,
      agentId: "codex",
      slot: 1,
      windowId: NO_VIEW_HANDLE,
      projectViewWebContentsId: NO_VIEW_HANDLE,
      vacantOnly: true,
      startedBy: STARTED_BY,
    });
    const [project, spec] = deps.spawn.mock.calls[0]!;
    expect(project).toBe(PROJECT);
    expect(result.status === "started" && result.terminalId).toBe(spec.terminalId);
    expect(spec).toMatchObject({
      agentId: "codex",
      cwd: SESSION_FOLDER,
      env: {
        DAINTREE_MCP_TOKEN: "bearer-1",
        DAINTREE_PROJECT_ID: PROJECT.id,
        DAINTREE_MCP_URL: "http://127.0.0.1:45454/mcp",
      },
      agentLaunchFlags: ["--model", "gpt-6.1"],
    });
    expect(spec.prompt).toMatch(/^Daintree started you/);
  });

  it("takes the lowest vacant slot when none is named, passing over one taken meanwhile", async () => {
    occupied = [0];
    deps.provision.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "LANE_OCCUPIED" })
    );
    await expect(start({ slot: undefined })).resolves.toMatchObject({
      status: "started",
      slot: 2,
    });
    expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([1, 2]);
  });

  it("refuses with no slot when every slot is taken", async () => {
    deps.provision.mockRejectedValue(Object.assign(new Error("busy"), { code: "LANE_OCCUPIED" }));
    await expect(start({ slot: undefined })).resolves.toEqual({
      status: "refused",
      reason: "no-slot",
    });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("answers its own session folder's trust question, and nothing else", async () => {
    screens = [trustScreen, READY_SCREEN];
    await expect(start()).resolves.toMatchObject({ status: "started", ready: true });
    expect(writes).toEqual(["\r"]);

    writes = [];
    screens = [trustScreen.replace("help-sessions/9630935fa5c2fbb7.codex", "repos/one")];
    await expect(start()).resolves.toMatchObject({
      status: "started",
      ready: false,
      notReadyReason: "timed-out",
    });
    expect(writes).toEqual([]);
  });

  it("starts only a live backend, and only one this machine can run", async () => {
    await expect(start({ agentId: "gemini" })).resolves.toEqual({
      status: "refused",
      reason: "agent-unavailable",
    });
    deps.launchableAgents = async () => [{ id: "gemini", byDefault: true }];
    await expect(start()).resolves.toEqual({ status: "refused", reason: "agent-unavailable" });
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("runs a backend the picker doesn't offer only when it's named", async () => {
    await expect(start({ agentId: "copilot" })).resolves.toMatchObject({
      status: "started",
      agentId: "copilot",
    });
    deps.launchableAgents = async () => [{ id: "copilot", byDefault: false }];
    await expect(start()).resolves.toEqual({ status: "refused", reason: "agent-unavailable" });
  });

  it("starts Antigravity by name or as the default, ready at its own prompt with no keys typed (#16815)", async () => {
    // agy's `--settings` trusts the lane folder, so its first screen is the prompt.
    screens = [
      ["  Antigravity CLI", "", ">", "", "? for shortcuts          Gemini 4 Carbon · high"].join(
        "\n"
      ),
    ];
    deps.launchableAgents = async () => [
      { id: "codex", byDefault: true },
      { id: "antigravity", byDefault: true },
    ];
    await expect(start({ agentId: "antigravity" })).resolves.toMatchObject({
      status: "started",
      agentId: "antigravity",
      ready: true,
    });
    expect(deps.provision).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "antigravity" })
    );
    expect(deps.spawn.mock.calls.at(-1)![1]).toMatchObject({ agentId: "antigravity" });
    expect(writes).toEqual([]);

    // The machine's own pick comes first in the list the deps answer with.
    deps.launchableAgents = async () => [
      { id: "antigravity", byDefault: true },
      { id: "codex", byDefault: true },
    ];
    await expect(start()).resolves.toMatchObject({ status: "started", agentId: "antigravity" });
  });

  it("refuses a slot in use without touching it, and an unknown project", async () => {
    deps.provision.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "LANE_OCCUPIED" })
    );
    await expect(start()).resolves.toEqual({ status: "refused", reason: "no-slot" });
    await expect(start({ projectId: "nope" })).resolves.toEqual({
      status: "refused",
      reason: "no-project",
    });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("revokes the session it provisioned when nothing spawned", async () => {
    deps.spawn.mockResolvedValueOnce(false);
    await expect(start()).resolves.toEqual({ status: "refused", reason: "launch-failed" });
    expect(deps.revoke).toHaveBeenCalledWith("session-1");
  });

  it("stops typing, and reports no start, once the run is no longer its slot's", async () => {
    screens = [trustScreen];
    running = false;
    await expect(start()).resolves.toEqual({ status: "refused", reason: "launch-failed" });
    expect(writes).toEqual([]);
  });

  it("reports a run that answered with its CLI's own failure as started but not ready", async () => {
    screens = [READY_SCREEN.replace("• Ready.", "■ You've hit your usage limit.")];
    await expect(start()).resolves.toMatchObject({
      status: "started",
      ready: false,
      notReadyReason: "agent-error",
    });
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("starts a schedule's run in its reserved terminal with its prompt, ready once at its prompt (#16169)", async () => {
    const scheduled = {
      terminalId: "terminal-reserved",
      prompt: "Pick a host and run the nightly checks.",
      scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
    };
    // At its prompt, working on the run's prompt rather than answering a greeting.
    screens = [
      ["› Pick a host and run the nightly checks.", "", "› Ask Codex to do anything"].join("\n"),
    ];

    const result = await start({
      slot: undefined,
      startedBy: { kind: "schedule", scheduleId: "schedule-1", runId: "run-1" },
      scheduled,
    });

    expect(result).toMatchObject({
      status: "started",
      terminalId: "terminal-reserved",
      ready: true,
    });
    // No greeting to wait on: the first look at its prompt is enough.
    expect(clock).toBe(0);
    expect(deps.spawn.mock.calls[0]![1]).toMatchObject({
      terminalId: "terminal-reserved",
      prompt: scheduled.prompt,
      scheduledRun: scheduled.scheduledRun,
    });
  });

  describe("resuming a conversation by id (#16753)", () => {
    const resume = { agentSessionId: "conv-7", cwd: SESSION_FOLDER, claimId: "claim-7" };
    const UPDATE_RESTART = { kind: "update-restart" } as const;

    it("reopens it in its own slot on its own agent, with no greeting, refusing a fresh one", async () => {
      // Back at its prompt with the conversation on screen: nothing to wait on.
      screens = [["› earlier work", "", "› Ask Codex to do anything"].join("\n")];
      const result = await start({
        slot: 2,
        agentId: "claude",
        startedBy: UPDATE_RESTART,
        resume,
        stillWanted: () => true,
      });

      expect(result).toMatchObject({ status: "started", slot: 2, agentId: "claude", ready: true });
      expect(clock).toBe(0);
      expect(deps.provision).toHaveBeenCalledTimes(1);
      expect(deps.provision.mock.calls[0]![0]).toMatchObject({
        slot: 2,
        agentId: "claude",
        vacantOnly: true,
        resumeClaimId: "claim-7",
        startedBy: UPDATE_RESTART,
      });
      expect(deps.provision.mock.calls[0]![0]).not.toHaveProperty("refuseKept");
      expect(deps.spawn.mock.calls[0]![1]).toMatchObject({
        prompt: "",
        resumeAgentSessionId: "conv-7",
        exactResume: true,
      });
    });

    it("never moves to another slot or agent, or starts with nothing to resume", async () => {
      deps.provision.mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "LANE_OCCUPIED" })
      );
      await expect(
        start({ slot: 2, agentId: "claude", startedBy: UPDATE_RESTART, resume })
      ).resolves.toEqual({ status: "refused", reason: "no-slot" });
      expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([2]);

      deps.provision.mockClear();
      for (const request of [
        { slot: undefined, agentId: "claude" },
        { slot: 2, agentId: undefined },
        { slot: 2, agentId: "claude", resume: { ...resume, agentSessionId: "" } },
        // Its provision would hold no claim on the lane.
        { slot: 2, agentId: "claude", resume: { ...resume, claimId: "" } },
        // A schedule's run starts fresh by definition.
        {
          slot: 2,
          agentId: "claude",
          scheduled: {
            terminalId: "terminal-reserved",
            prompt: "Run the checks.",
            scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
          },
        },
      ]) {
        await expect(start({ startedBy: UPDATE_RESTART, resume, ...request })).resolves.toEqual({
          status: "refused",
          reason: "launch-failed",
        });
      }
      // Not one this machine starts with no view: no other agent stands in.
      await expect(
        start({ slot: 2, agentId: "gemini", startedBy: UPDATE_RESTART, resume })
      ).resolves.toEqual({ status: "refused", reason: "agent-unavailable" });
      expect(deps.provision).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it("gives the lane back unspawned when its folder isn't the conversation's, or it's no longer wanted", async () => {
      await expect(
        start({
          slot: 2,
          agentId: "claude",
          startedBy: UPDATE_RESTART,
          resume: { ...resume, cwd: "/elsewhere" },
        })
      ).resolves.toEqual({ status: "refused", reason: "folder-moved" });

      // Still wanted when it provisioned, no longer once its flags were read.
      let wanted = true;
      let flagsRead: ((flags: string[]) => void) | undefined;
      deps.launchFlags = () =>
        new Promise<string[]>((resolve) => {
          flagsRead = resolve;
        });
      const started = start({
        slot: 2,
        agentId: "claude",
        startedBy: UPDATE_RESTART,
        resume,
        stillWanted: () => wanted,
      });
      await vi.waitFor(() => expect(flagsRead).toBeDefined());
      expect(deps.provision).toHaveBeenCalledTimes(2);
      wanted = false;
      flagsRead!([]);
      await expect(started).resolves.toEqual({ status: "refused", reason: "withdrawn" });

      expect(deps.revoke.mock.calls).toEqual([["session-1"], ["session-1"]]);
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  it("tries a slot keeping a stopped session's conversation last", async () => {
    occupied = [0];
    deps.keptSlots = () => [1];

    await expect(start({ slot: undefined })).resolves.toMatchObject({ slot: 2 });
    expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([2]);

    // Every fresh slot is taken first, in order, before the kept one is touched.
    const fresh = ASSISTANT_SLOTS.filter((slot) => slot !== 0 && slot !== 1);
    deps.provision.mockClear();
    for (const _slot of fresh) {
      deps.provision.mockRejectedValueOnce(
        Object.assign(new Error("taken"), { code: "LANE_OCCUPIED" })
      );
    }
    await expect(start({ slot: undefined })).resolves.toMatchObject({ slot: 1 });
    expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([...fresh, 1]);
  });

  describe("preserving kept conversations (#16763)", () => {
    const LANE_KEPT = () => Object.assign(new Error("kept"), { code: "LANE_KEPT" });

    it("never tries a kept slot, and has every provision refuse one kept meanwhile", async () => {
      occupied = [0];
      deps.keptSlots = () => [1, 3];

      await expect(start({ slot: undefined, preserveKept: true })).resolves.toMatchObject({
        slot: 2,
      });
      expect(deps.provision.mock.calls[0]![0]).toMatchObject({ slot: 2, refuseKept: true });

      // Kept since it was listed: passed over for the next vacant one.
      deps.provision.mockClear();
      deps.provision.mockRejectedValueOnce(LANE_KEPT());
      await expect(start({ slot: undefined, preserveKept: true })).resolves.toMatchObject({
        slot: 4,
      });
      expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([2, 4]);
      // Every attempt is held to it, the retry included.
      expect(deps.provision.mock.calls.every(([input]) => input.refuseKept === true)).toBe(true);
    });

    it("refuses with no slot rather than take a kept one once the vacant ones run out", async () => {
      deps.keptSlots = () => [0, 1];
      const fresh = ASSISTANT_SLOTS.filter((slot) => slot > 1);
      for (const _slot of fresh) {
        deps.provision.mockRejectedValueOnce(
          Object.assign(new Error("taken"), { code: "LANE_OCCUPIED" })
        );
      }

      await expect(start({ slot: undefined, preserveKept: true })).resolves.toEqual({
        status: "refused",
        reason: "no-slot",
      });
      expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual(fresh);
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it("refuses a kept slot it names, as listed or as its provision finds it", async () => {
      deps.keptSlots = () => [1];
      await expect(start({ slot: 1, preserveKept: true })).resolves.toEqual({
        status: "refused",
        reason: "kept",
      });
      expect(deps.provision).not.toHaveBeenCalled();

      deps.provision.mockRejectedValueOnce(LANE_KEPT());
      await expect(start({ slot: 2, preserveKept: true })).resolves.toEqual({
        status: "refused",
        reason: "kept",
      });
      expect(deps.provision.mock.calls.map(([input]) => input.slot)).toEqual([2]);
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it("reports a resume whose claim was dropped before its provision as withdrawn, not taken", async () => {
      deps.provision.mockRejectedValueOnce(
        Object.assign(new Error("being resumed"), { code: "LANE_OCCUPIED" })
      );
      await expect(
        start({
          slot: 2,
          agentId: "claude",
          resume: { agentSessionId: "conv-7", cwd: SESSION_FOLDER, claimId: "claim-7" },
          stillWanted: () => false,
        })
      ).resolves.toEqual({ status: "refused", reason: "withdrawn" });
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it("answers a running slot it names as in use, though its lane has a pointer too", async () => {
      occupied = [1];
      deps.keptSlots = () => [1];
      deps.provision.mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "LANE_OCCUPIED" })
      );
      await expect(start({ slot: 1, preserveKept: true })).resolves.toEqual({
        status: "refused",
        reason: "no-slot",
      });
    });

    it("leaves a resume in its own kept slot", async () => {
      deps.keptSlots = () => [2];
      screens = [["› earlier work", "", "› Ask Codex to do anything"].join("\n")];
      await expect(
        start({
          slot: 2,
          agentId: "claude",
          preserveKept: true,
          resume: { agentSessionId: "conv-7", cwd: SESSION_FOLDER, claimId: "claim-7" },
        })
      ).resolves.toMatchObject({ status: "started", slot: 2 });
      expect(deps.provision.mock.calls[0]![0]).not.toHaveProperty("refuseKept");
    });
  });
});

describe("spawnAndConfirm (#13511)", () => {
  it("answers whether the PTY really started, not just that its spawn was queued", async () => {
    const pty = new EventEmitter();
    const failed = spawnAndConfirm(
      pty as never,
      async () => {
        pty.emit("spawn-result", "other-terminal", { success: true });
        pty.emit("spawn-result", "t-1", { success: false });
        return true;
      },
      "t-1"
    );
    await expect(failed).resolves.toBe(false);

    const started = spawnAndConfirm(
      pty as never,
      async () => {
        setTimeout(() => pty.emit("spawn-result", "t-2", { success: true }), 0);
        return true;
      },
      "t-2"
    );
    await expect(started).resolves.toBe(true);
    expect(pty.listenerCount("spawn-result")).toBe(0);
  });

  it("reads no report in time as no start when the caller asks it to (#14445)", async () => {
    vi.useFakeTimers();
    try {
      const pty = new EventEmitter();
      const strict = spawnAndConfirm(pty as never, async () => true, "t-1", {
        unreportedStarted: false,
      });
      const lenient = spawnAndConfirm(pty as never, async () => true, "t-2");
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(strict).resolves.toBe(false);
      await expect(lenient).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never waits on a spawn the handler refused outright", async () => {
    const pty = new EventEmitter();
    await expect(spawnAndConfirm(pty as never, async () => false, "t-1")).resolves.toBe(false);
    await expect(spawnAndConfirm(null, async () => true, "t-1")).resolves.toBe(false);
  });
});
