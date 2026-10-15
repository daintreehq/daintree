import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProjectViewResult } from "../../client/hostProjectViews.js";
import {
  HostAssistantStarter,
  type HostAssistantStarterDeps,
  type ViewDispatchResult,
} from "../HostAssistantStarter.js";
import type { EnrollStartedResult, LaneList } from "../linkMethods.js";

const HOST = "studio-01";
const PROJECT = "proj-1";
const VIEW = 77;
const SESSION_FOLDER =
  "/Users/me/Library/Application Support/Daintree/help-sessions/9630935fa5c2fbb7";

const trustScreen = (folder: string) =>
  [
    " Accessing workspace:",
    ` ${folder.slice(0, 36)}`,
    ` ${folder.slice(36)}`,
    " Quick safety check: Is this a project you created or one you trust?",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
const READY_SCREEN = "Hi! How can I help?\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("HostAssistantStarter", () => {
  let clock: number;
  let lanes: LaneList;
  let screens: string[];
  let view: HostProjectViewResult;
  let drivingHere: boolean;
  let vacant: boolean;
  let launched: unknown;
  let enrollAnswer: EnrollStartedResult["status"];
  let allowed: boolean;
  let calls: string[];
  let deps: {
    listLanes: ReturnType<typeof vi.fn>;
    projectPath: ReturnType<typeof vi.fn>;
    prepareView: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    enrollStarted: ReturnType<typeof vi.fn>;
  };
  let starter: HostAssistantStarter;
  const authorized = () => allowed;

  beforeEach(() => {
    clock = 0;
    lanes = { lanes: [], assistants: [] };
    screens = [READY_SCREEN];
    view = { status: "ready", webContentsId: VIEW, created: true };
    drivingHere = true;
    vacant = false;
    launched = undefined;
    enrollAnswer = "enrolled";
    allowed = true;
    calls = [];
    deps = {
      listLanes: vi.fn(async () => structuredClone(lanes)),
      projectPath: vi.fn(async (_host: string, projectId: string) =>
        projectId === PROJECT ? "/repos/one" : null
      ),
      prepareView: vi.fn(async () => view),
      dispatch: vi.fn(async (_wc: number, actionId: string, args: unknown) => {
        calls.push(`${actionId} ${JSON.stringify(args)}`);
        if (actionId === "help.launchAgent") {
          const { slot } = args as { slot: number };
          return {
            ok: true,
            result: launched ?? {
              slot,
              terminalId: `help-${slot}`,
              sessionId: `session-${slot}`,
              agentId: "claude",
              cwd: SESSION_FOLDER,
            },
          } satisfies ViewDispatchResult;
        }
        return { ok: true, result: { pressed: true } };
      }),
      invoke: vi.fn(
        async (
          _host: string,
          _wc: number,
          _projectId: string,
          channel: string,
          args: unknown[]
        ) => {
          if (channel === "drive-lease:get") {
            return { isHolderEndpoint: drivingHere, holder: vacant ? null : { leaseId: 1 } };
          }
          if (channel === "drive-lease:take-over") {
            calls.push("take-over");
            if (vacant) drivingHere = true;
            vacant = false;
            return null;
          }
          if (channel === "terminal:get-serialized-state") {
            calls.push(`read ${String(args[0])}`);
            const screen = screens.length > 1 ? screens.shift()! : screens[0]!;
            return { data: screen };
          }
          throw new Error(`unexpected ${channel}`);
        }
      ),
      enrollStarted: vi.fn(
        async (_host: string, payload: { projectId: string; slot: number; sessionId: string }) => {
          calls.push(`enroll ${payload.slot} ${payload.sessionId}`);
          if (enrollAnswer !== "enrolled") return { status: enrollAnswer, lane: null };
          const lane = {
            projectId: payload.projectId,
            slot: payload.slot,
            generation: `gen-${payload.slot}`,
            available: true,
            agentId: "claude",
          };
          lanes.lanes.push(lane);
          lanes.assistants!.push({
            projectId: payload.projectId,
            slot: payload.slot,
            agentId: "claude",
          });
          return { status: "enrolled", lane };
        }
      ),
    };
    starter = new HostAssistantStarter({
      ...(deps as unknown as HostAssistantStarterDeps),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  });

  it("answers with an assistant already enrolled for this Shell there, once its view drives", async () => {
    lanes.lanes = [
      { projectId: PROJECT, slot: 2, generation: "g2", available: true, agentId: "codex" },
    ];
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "ready",
      projectId: PROJECT,
      slot: 2,
      agentId: "codex",
      generation: "g2",
      available: true,
      started: false,
    });
    expect(deps.prepareView).toHaveBeenCalledWith(HOST, PROJECT, "/repos/one");
    expect(calls).toEqual([]);
  });

  it("starts one in a lane no assistant on the host uses, answers its own folder's trust question, then enrolls that run", async () => {
    // Slot 0 runs someone else's assistant, which this view's own tabs may not show.
    lanes.assistants = [{ projectId: PROJECT, slot: 0, agentId: "claude" }];
    screens = [trustScreen(SESSION_FOLDER), READY_SCREEN];
    const result = await starter.start(HOST, PROJECT, { agentId: "claude", authorized });
    expect(result).toEqual({
      status: "ready",
      projectId: PROJECT,
      slot: 1,
      agentId: "claude",
      generation: "gen-1",
      available: true,
      started: true,
    });
    expect(calls).toEqual([
      `help.launchAgent {"agentId":"claude","slot":1,"vacantOnly":true,"greeting":"hub"}`,
      "read help-1",
      `terminal.sendKeys {"terminalId":"help-1","choose":"Yes, I trust this folder"}`,
      "read help-1",
      "enroll 1 session-1",
    ]);
  });

  it("never answers a trust question about any other folder, or for a CLI it doesn't know", async () => {
    screens = [trustScreen("/Users/me/Downloads/somebody-elses-repo/and/more/of/it/here")];
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "timed-out",
    });
    launched = {
      slot: 0,
      terminalId: "help-0",
      sessionId: "session-0",
      agentId: "gemini",
      cwd: SESSION_FOLDER,
    };
    screens = [trustScreen(SESSION_FOLDER)];
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toMatchObject({
      reason: "timed-out",
    });
    expect(calls.some((call) => call.startsWith("terminal.sendKeys"))).toBe(false);
    expect(calls.some((call) => call.startsWith("enroll"))).toBe(false);
  });

  it("never takes over a running assistant it didn't start: it starts one beside it", async () => {
    lanes.assistants = [{ projectId: PROJECT, slot: 0, agentId: "claude" }];
    const result = await starter.start(HOST, PROJECT, { authorized });
    expect(result).toMatchObject({ status: "ready", slot: 1, started: true });
    expect(calls).not.toContain("enroll 0 session-0");
  });

  it("starts another on request even with one enrolled for this Shell there", async () => {
    lanes.lanes = [
      { projectId: PROJECT, slot: 0, generation: "g0", available: true, agentId: "claude" },
    ];
    lanes.assistants = [{ projectId: PROJECT, slot: 0, agentId: "claude" }];
    const result = await starter.start(HOST, PROJECT, { startNew: true, authorized });
    expect(result).toMatchObject({ status: "ready", slot: 1, started: true });
  });

  it("refuses a project at its assistant limit, or one running a different agent, before launching", async () => {
    lanes.assistants = [0, 1, 2].map((slot) => ({ projectId: PROJECT, slot, agentId: "claude" }));
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "no-slot",
    });
    lanes.assistants = [{ projectId: PROJECT, slot: 0, agentId: "claude" }];
    await expect(starter.start(HOST, PROJECT, { agentId: "codex", authorized })).resolves.toEqual({
      status: "refused",
      reason: "agent-mismatch",
    });
    expect(calls.filter((call) => call.startsWith("help.launchAgent"))).toEqual([]);
  });

  it("stops as soon as the person withdraws consent, before anything more changes", async () => {
    let checks = 0;
    const withdrawnAfterLaunch = () => ++checks <= 3;
    await expect(
      starter.start(HOST, PROJECT, { authorized: withdrawnAfterLaunch })
    ).resolves.toEqual({ status: "refused", reason: "consent-withdrawn" });
    expect(calls.filter((call) => call.startsWith("help.launchAgent"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("enroll"))).toBe(false);

    allowed = false;
    calls = [];
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toMatchObject({
      reason: "consent-withdrawn",
    });
    expect(deps.prepareView).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("takes a lease nobody holds, as opening the project would, and only then launches", async () => {
    drivingHere = false;
    vacant = true;
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toMatchObject({
      status: "ready",
      started: true,
    });
    expect(calls[0]).toBe("take-over");
  });

  it("won't launch from a view that doesn't drive the project", async () => {
    drivingHere = false;
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "driven-elsewhere",
    });
    expect(calls).toEqual([]);
  });

  it("names why it couldn't start: no such project, no window on the host, a launch elsewhere", async () => {
    await expect(starter.start(HOST, "nope", { authorized })).resolves.toEqual({
      status: "refused",
      reason: "no-project",
    });
    view = { status: "no-window" };
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "no-window",
    });
    view = { status: "ready", webContentsId: VIEW, created: false };
    launched = {
      slot: 2,
      terminalId: "help-2",
      sessionId: "session-2",
      agentId: "claude",
      cwd: SESSION_FOLDER,
    };
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "launch-failed",
    });
  });

  it("reports an enrollment the host refused", async () => {
    enrollAnswer = "occupied";
    await expect(starter.start(HOST, PROJECT, { authorized })).resolves.toEqual({
      status: "refused",
      reason: "not-enrolled",
    });
  });

  it("takes two requests for one project in turn, so the second finds what the first enrolled", async () => {
    const [first, second] = await Promise.all([
      starter.start(HOST, PROJECT, { authorized }),
      starter.start(HOST, PROJECT, { authorized }),
    ]);
    expect(first).toMatchObject({ status: "ready", slot: 0, started: true });
    expect(second).toMatchObject({ status: "ready", slot: 0, started: false });
    expect(calls.filter((call) => call.startsWith("help.launchAgent"))).toHaveLength(1);
  });

  describe("reattach", () => {
    it("gives each project with a lane enrolled here a driving view again, starting nothing", async () => {
      lanes.lanes = [
        { projectId: PROJECT, slot: 0, generation: "g0", available: true, agentId: "claude" },
        { projectId: PROJECT, slot: 1, generation: "g1", available: true, agentId: "claude" },
        { projectId: "nope", slot: 0, generation: "gx", available: true, agentId: "claude" },
      ];
      await expect(starter.reattach(HOST, authorized)).resolves.toEqual([
        { projectId: "nope", reason: "no-project" },
      ]);
      expect(deps.prepareView).toHaveBeenCalledTimes(1);
      expect(deps.prepareView).toHaveBeenCalledWith(HOST, PROJECT, "/repos/one");
      expect(calls).toEqual([]);
    });

    it("stops when consent is withdrawn while it looks the project up", async () => {
      lanes.lanes = [
        { projectId: PROJECT, slot: 0, generation: "g0", available: true, agentId: "claude" },
      ];
      deps.projectPath.mockImplementationOnce(async () => {
        allowed = false;
        return "/repos/one";
      });
      await expect(starter.reattach(HOST, authorized)).resolves.toEqual([
        { projectId: PROJECT, reason: "consent-withdrawn" },
      ]);
      expect(deps.prepareView).not.toHaveBeenCalled();
    });

    it("says which projects still have nowhere to go, and does nothing without consent", async () => {
      lanes.lanes = [
        { projectId: PROJECT, slot: 0, generation: "g0", available: true, agentId: "claude" },
      ];
      view = { status: "no-window" };
      await expect(starter.reattach(HOST, authorized)).resolves.toEqual([
        { projectId: PROJECT, reason: "no-window" },
      ]);
      allowed = false;
      deps.prepareView.mockClear();
      await expect(starter.reattach(HOST, authorized)).resolves.toEqual([]);
      expect(deps.prepareView).not.toHaveBeenCalled();
    });
  });
});
