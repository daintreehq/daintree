import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import type {
  AssistantMessagingEnrollResult,
  AssistantMessagingState,
} from "../../../../shared/types/ipc/assistantMessaging.js";
import type { RunningLaneSession } from "../../../services/HelpSessionService.js";
import { AssistantMessagingPolicy } from "../../../remote/assistant/AssistantMessagingPolicy.js";
import { registerRemoteService } from "../../../remote/runtime.js";
import type { IpcContext } from "../../types.js";
import { assistantMessagingNamespace } from "../assistantMessaging.js";

type Ctx = IpcContext;
const getState = assistantMessagingNamespace.ops.getState.handler as unknown as (
  ctx: Ctx,
  input: unknown
) => Promise<AssistantMessagingState>;
const setLaneEnrolled = assistantMessagingNamespace.ops.setLaneEnrolled.handler as unknown as (
  ctx: Ctx,
  input: unknown
) => Promise<AssistantMessagingEnrollResult>;
const setPaused = assistantMessagingNamespace.ops.setPaused.handler as unknown as (
  ctx: Ctx,
  paused: unknown
) => Promise<boolean>;

function localCtx(projectId: string | null = "proj"): Ctx {
  return {
    senderWindow: {} as Electron.BrowserWindow,
    projectId,
    endpoint: { kind: "local-view" },
  } as unknown as Ctx;
}

function remoteCtx(linkSessionId: string | undefined, projectId = "proj"): Ctx {
  return {
    senderWindow: null,
    projectId,
    endpoint: { kind: "remote-view", linkSessionId },
  } as unknown as Ctx;
}

describe("assistant messaging IPC", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const running = new Map<string, RunningLaneSession>();
  let hosts = 1;
  let policy: AssistantMessagingPolicy;
  const teardowns: Array<() => void> = [];

  const run = (slot: number, sessionId: string) =>
    running.set(`proj:${slot}`, {
      sessionId,
      terminalId: `t-${sessionId}`,
      projectViewWebContentsId: 1,
    });

  beforeEach(() => {
    // Exercise supported-platform behavior on every runner; Windows denial has its own test.
    Object.defineProperty(process, "platform", { value: "darwin" });
    running.clear();
    hosts = 1;
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(`${projectId}:${slot}`) ?? null,
      getLiveGeneration: () => 1,
      isHostMessagingEnabled: () => true,
      onSessionEnded: () => () => {},
      platform: "darwin",
    });
    teardowns.push(registerRemoteService("assistantMessagingPolicy", policy));
    teardowns.push(
      registerRemoteService("assistantMessagingSurface", {
        hasHosts: () => hosts > 0,
        revision: () => policy.getRevision(),
      })
    );
  });

  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown();
    policy.dispose();
    vi.unstubAllGlobals();
    Object.defineProperty(process, "platform", platform);
  });

  it("stays unavailable to this machine's windows until a host exists", async () => {
    hosts = 0;
    const state = await getState(localCtx(), { projectId: "proj", slot: 0 });
    expect(state.available).toBe(false);
    run(0, "s1");
    const result = await setLaneEnrolled(localCtx(), {
      projectId: "proj",
      slot: 0,
      enrolled: true,
    });
    expect(result.refusal).toBe("unavailable");
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
  });

  it("is available to a remote window with no hosts of its own: its host exists", async () => {
    hosts = 0;
    const state = await getState(remoteCtx("link-a"), { projectId: "proj", slot: 0 });
    expect(state.available).toBe(true);
    expect(state.canPause).toBe(false);
  });

  it("is never available on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const state = await getState(localCtx(), { projectId: "proj", slot: 0 });
      expect(state.available).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("enrolls a local window's lane as this machine, making it the hub", async () => {
    run(0, "s1");
    const result = await setLaneEnrolled(localCtx(), {
      projectId: "proj",
      slot: 0,
      enrolled: true,
    });
    expect(result.refusal).toBeNull();
    expect(result.state.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    expect(policy.getHub()?.slot).toBe(0);
  });

  it("enrolls a remote window's lane as that window's link session, never a claimed one", async () => {
    run(0, "s1");
    await setLaneEnrolled(remoteCtx("link-a"), {
      projectId: "proj",
      slot: 0,
      enrolled: true,
      shell: { kind: "local" },
    });
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })?.enrolledBy).toEqual({
      kind: "remote",
      linkSessionId: "link-a",
    });
    expect(policy.getHub()).toBeNull();

    const other = await getState(remoteCtx("link-b"), { projectId: "proj", slot: 0 });
    expect(other.lane).toEqual({ enrolled: false, enrolledElsewhere: true, ended: null });
    const refused = await setLaneEnrolled(remoteCtx("link-b"), {
      projectId: "proj",
      slot: 0,
      enrolled: false,
    });
    expect(refused.refusal).toBe("wrong-shell");
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })).not.toBeNull();
  });

  it("shows a lane whose Shell is away as on, so turning it off withdraws it (#13332)", async () => {
    run(0, "s1");
    await setLaneEnrolled(remoteCtx("link-a"), { projectId: "proj", slot: 0, enrolled: true });
    policy.bindSender("link-a", "sender-a");
    policy.releaseLinkSession("link-a");

    const seen = await getState(localCtx(), { projectId: "proj", slot: 0 });
    expect(seen.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    const off = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: false });
    expect(off.refusal).toBeNull();
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    // Its Shell coming back finds nothing to take.
    expect(policy.bindSender("link-a2", "sender-a")).toEqual([]);
  });

  it("refuses a remote view with no link session", async () => {
    run(0, "s1");
    const result = await setLaneEnrolled(remoteCtx(undefined), {
      projectId: "proj",
      slot: 0,
      enrolled: true,
    });
    expect(result.refusal).toBe("unavailable");
  });

  it("refuses a lane of a project the view isn't showing, and malformed input", async () => {
    run(0, "s1");
    for (const input of [
      { projectId: "other", slot: 0, enrolled: true },
      { projectId: "proj", slot: 7, enrolled: true },
      { projectId: "proj", slot: 0, enrolled: "yes" },
      null,
    ]) {
      const result = await setLaneEnrolled(localCtx(), input);
      expect(result.refusal).toBe("unavailable");
    }
    expect(policy.getHub()).toBeNull();
  });

  it("says why it can't enroll a lane that isn't running, or a second hub", async () => {
    const idle = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    expect(idle.refusal).toBe("not-running");

    run(0, "s1");
    run(1, "s2");
    await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    const second = await setLaneEnrolled(localCtx(), {
      projectId: "proj",
      slot: 1,
      enrolled: true,
    });
    expect(second.refusal).toBe("hub-taken");
    expect(policy.getHub()?.slot).toBe(0);
  });

  it("turning a lane on twice keeps its generation; turning it off withdraws it", async () => {
    run(0, "s1");
    await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    const generation = policy.getHub()?.generation;
    await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    expect(policy.getHub()?.generation).toBe(generation);

    const off = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: false });
    expect(off.refusal).toBeNull();
    expect(off.state.lane.enrolled).toBe(false);
    expect(off.state.lane.ended).toBeNull();
  });

  it("shows how a lane's enrollment ended only to the Shell that gave it", async () => {
    run(0, "s1");
    await setLaneEnrolled(remoteCtx("link-a"), { projectId: "proj", slot: 0, enrolled: true });
    run(0, "s2");
    const mine = await getState(remoteCtx("link-a"), { projectId: "proj", slot: 0 });
    expect(mine.lane.ended?.reason).toBe("relaunched");
    const theirs = await getState(localCtx(), { projectId: "proj", slot: 0 });
    expect(theirs.lane.ended).toBeNull();
  });

  it("lets this machine's windows pause, while a remote window only sees the pause", async () => {
    expect(await setPaused(localCtx(), true)).toBe(true);
    expect(policy.isPaused()).toBe(true);
    expect(await setPaused(remoteCtx("link-a"), false)).toBe(true);
    expect(policy.isPaused()).toBe(true);
    expect((await getState(remoteCtx("link-a"), { projectId: "proj", slot: 0 })).paused).toBe(true);
    expect(await setPaused(localCtx(), "no")).toBe(true);
  });

  it("answers unavailable before the policy is installed", async () => {
    for (const teardown of teardowns.splice(0)) teardown();
    const state = await getState(localCtx(), { projectId: "proj", slot: 0 });
    expect(state.available).toBe(false);
    expect(await setPaused(localCtx(), true)).toBe(false);
  });

  it("answers availability without a lane, for settings that aren't about one (#13441)", async () => {
    expect(await getState(localCtx(), undefined)).toMatchObject({
      available: true,
      lane: { enrolled: false, enrolledElsewhere: false, ended: null },
    });
    hosts = 0;
    expect((await getState(localCtx(), undefined)).available).toBe(false);
    expect((await getState(remoteCtx("link-a"), undefined)).available).toBe(true);
  });

  it("keeps the saved default from turning a lane back on after the person turned it off (#13441)", async () => {
    run(0, "s1");
    expect(policy.enrollByDefault({ projectId: "proj", slot: 0 }, { kind: "local" }).ok).toBe(true);
    const off = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: false });
    expect(off.state.lane.enrolled).toBe(false);
    expect(policy.enrollByDefault({ projectId: "proj", slot: 0 }, { kind: "local" })).toEqual({
      ok: false,
      reason: "declined",
    });
    // Turning it on again is the person's own choice and still works.
    const on = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    expect(on.refusal).toBeNull();
    expect(on.state.lane.enrolled).toBe(true);
  });
});
