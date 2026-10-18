import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      reason: "launch-failed",
    });
    deps.launchableAgents = async () => [{ id: "gemini", byDefault: true }];
    await expect(start()).resolves.toEqual({ status: "refused", reason: "launch-failed" });
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("runs a backend the picker doesn't offer only when it's named", async () => {
    await expect(start({ agentId: "copilot" })).resolves.toMatchObject({
      status: "started",
      agentId: "copilot",
    });
    deps.launchableAgents = async () => [{ id: "copilot", byDefault: false }];
    await expect(start()).resolves.toEqual({ status: "refused", reason: "launch-failed" });
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

  it("never waits on a spawn the handler refused outright", async () => {
    const pty = new EventEmitter();
    await expect(spawnAndConfirm(pty as never, async () => false, "t-1")).resolves.toBe(false);
    await expect(spawnAndConfirm(null, async () => true, "t-1")).resolves.toBe(false);
  });
});
