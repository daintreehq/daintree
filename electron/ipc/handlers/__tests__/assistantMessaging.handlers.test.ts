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
  /** Whether this machine listens as a host; a remote view's host does by definition. */
  let listening = false;
  let accepting = true;
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
    listening = false;
    accepting = true;
    policy = new AssistantMessagingPolicy({
      getRunningLaneSession: (projectId, slot) => running.get(`${projectId}:${slot}`) ?? null,
      listRunningLanes: () =>
        [...running.keys()].map((key) => ({
          projectId: key.split(":")[0]!,
          slot: Number(key.split(":")[1]),
          agentId: "claude",
        })),
      getLiveGeneration: () => 1,
      isHostMessagingEnabled: () => true,
      acceptsRemoteMessages: () => accepting,
      onSessionEnded: () => () => {},
      platform: "darwin",
    });
    teardowns.push(registerRemoteService("assistantMessagingPolicy", policy));
    teardowns.push(
      registerRemoteService("assistantMessagingSurface", {
        hasHosts: () => hosts > 0,
        listensAsHost: () => listening,
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

  it("turns a local window's lane off and on without enrolling it, on a Shell with hosts (#13468)", async () => {
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    // This machine's own assistants need no enrollment: the lane reads on from the start.
    expect((await getState(localCtx(), lane)).lane).toEqual({
      enrolled: true,
      enrolledElsewhere: false,
      ended: null,
    });

    const off = await setLaneEnrolled(localCtx(), { ...lane, enrolled: false });
    expect(off.refusal).toBeNull();
    expect(off.state.lane).toEqual({ enrolled: false, enrolledElsewhere: false, ended: null });
    expect(policy.checkOpen(lane, "admit")).toEqual({ ok: false, reason: "declined" });

    const on = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
    expect(on.refusal).toBeNull();
    expect(on.state.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    expect(policy.checkOpen(lane, "admit").ok).toBe(true);
    // Neither direction ever takes an enrollment for this machine.
    expect(policy.getEnrollment(lane)).toBeNull();
  });

  it("keeps two of this machine's lanes on independently (#13468)", async () => {
    const first = { projectId: "proj", slot: 0 };
    const second = { projectId: "proj", slot: 1 };
    run(0, "s1");
    run(1, "s2");
    for (const lane of [first, second]) {
      const on = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
      expect(on.refusal).toBeNull();
      expect(on.state.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    }

    await setLaneEnrolled(localCtx(), { ...first, enrolled: false });
    expect((await getState(localCtx(), first)).lane.enrolled).toBe(false);
    expect((await getState(localCtx(), second)).lane).toEqual({
      enrolled: true,
      enrolledElsewhere: false,
      ended: null,
    });
    expect(policy.getEnrollment(first)).toBeNull();
    expect(policy.getEnrollment(second)).toBeNull();
  });

  it("never enrolls anything from a remote window's toggle, whatever shell it claims", async () => {
    run(0, "s1");
    const on = await setLaneEnrolled(remoteCtx("link-a"), {
      projectId: "proj",
      slot: 0,
      enrolled: true,
      shell: { kind: "local" },
    });
    expect(on.refusal).toBeNull();
    // Where a lane's own messages go is only for a run that Shell's view started.
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
  });

  it("holds a remote window's off for this machine's window too, until either turns it on", async () => {
    listening = true;
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    const off = await setLaneEnrolled(remoteCtx("link-a"), { ...lane, enrolled: false });
    expect(off.state.lane.enrolled).toBe(false);
    expect((await getState(localCtx(), lane)).lane.enrolled).toBe(false);
    const on = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
    expect(on.refusal).toBeNull();
    expect((await getState(remoteCtx("link-a"), lane)).lane.enrolled).toBe(true);
    expect(policy.getEnrollment(lane)).toBeNull();
  });

  it("shows a lane on to every Shell, and lets any of them turn its run off (#13467)", async () => {
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    // A run link-a's view started: its own messages go to link-a.
    expect(policy.enroll(lane, { kind: "remote", linkSessionId: "link-a" }).ok).toBe(true);

    const other = await getState(remoteCtx("link-b"), lane);
    expect(other.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    const off = await setLaneEnrolled(remoteCtx("link-b"), { ...lane, enrolled: false });
    expect(off.refusal).toBeNull();
    expect(off.state.lane.enrolled).toBe(false);
    expect(policy.checkOpen(lane, "admit")).toEqual({ ok: false, reason: "declined" });
    // Off ends where the lane's own messages went, too.
    expect(policy.getEnrollment(lane)).toBeNull();
    expect((await getState(remoteCtx("link-a"), lane)).lane.enrolled).toBe(false);

    const on = await setLaneEnrolled(remoteCtx("link-a"), { ...lane, enrolled: true });
    expect(on.refusal).toBeNull();
    expect(policy.checkOpen(lane, "admit").ok).toBe(true);

    // A relaunch accepts again, whoever turned the run before it off.
    await setLaneEnrolled(remoteCtx("link-b"), { ...lane, enrolled: false });
    run(0, "s2");
    expect((await getState(remoteCtx("link-b"), lane)).lane.enrolled).toBe(true);
  });

  it("offers a listening host's own window the controls with no hosts of its own", async () => {
    hosts = 0;
    listening = true;
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    const state = await getState(localCtx(), lane);
    expect(state.available).toBe(true);
    expect(state.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    const off = await setLaneEnrolled(localCtx(), { ...lane, enrolled: false });
    expect(off.state.lane.enrolled).toBe(false);
    const on = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
    expect(on.state.lane.enrolled).toBe(true);
    // The toggle only ever stops what other machines send; it enrolls nothing.
    expect(policy.getEnrollment(lane)).toBeNull();
  });

  it("shows a lane off, and won't turn it on, while this machine doesn't accept messages", async () => {
    accepting = false;
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    expect((await getState(remoteCtx("link-a"), lane)).lane.enrolled).toBe(false);
    const on = await setLaneEnrolled(remoteCtx("link-a"), { ...lane, enrolled: true });
    expect(on.refusal).toBe("unavailable");
    expect(on.state.lane.enrolled).toBe(false);
    // This machine's own window, on a Shell with hosts but not listening, is refused the same way.
    const local = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
    expect(local.refusal).toBe("unavailable");
    expect(local.state.lane).toEqual({ enrolled: false, enrolledElsewhere: false, ended: null });
    expect(policy.getEnrollment(lane)).toBeNull();
  });

  it("shows a lane whose Shell is away as on, so turning it off withdraws it (#13332)", async () => {
    run(0, "s1");
    policy.enroll({ projectId: "proj", slot: 0 }, { kind: "remote", linkSessionId: "link-a" });
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
    // None of them reached the lane the view does show.
    expect(policy.isRunDeclined({ projectId: "proj", slot: 0 })).toBe(false);
    expect(policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
  });

  it("says why it can't turn on a lane that isn't running", async () => {
    const idle = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    expect(idle.refusal).toBe("not-running");
    expect(idle.state.lane).toEqual({ enrolled: false, enrolledElsewhere: false, ended: null });
  });

  it("turning a lane on leaves a Shell's enrollment as it is; turning it off withdraws it", async () => {
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    expect(policy.enroll(lane, { kind: "remote", linkSessionId: "link-a" }).ok).toBe(true);
    const generation = policy.getEnrollment(lane)?.generation;
    for (let i = 0; i < 2; i++) {
      const on = await setLaneEnrolled(localCtx(), { ...lane, enrolled: true });
      expect(on.refusal).toBeNull();
      // Another Shell holding the lane's own messages never shows as held elsewhere.
      expect(on.state.lane).toEqual({ enrolled: true, enrolledElsewhere: false, ended: null });
    }
    expect(policy.getEnrollment(lane)?.generation).toBe(generation);

    const off = await setLaneEnrolled(localCtx(), { ...lane, enrolled: false });
    expect(off.refusal).toBeNull();
    expect(off.state.lane.enrolled).toBe(false);
    expect(off.state.lane.ended).toBeNull();
    expect(policy.getEnrollment(lane)).toBeNull();
  });

  it("shows how an enrollment ended only to its own Shell, never over a lane open to all", async () => {
    const lane = { projectId: "proj", slot: 0 };
    run(0, "s1");
    policy.enroll(lane, { kind: "remote", linkSessionId: "link-a" });
    run(0, "s2");
    // Open to every Shell, nobody hears about it.
    expect((await getState(remoteCtx("link-a"), lane)).lane.ended).toBeNull();

    accepting = false;
    const mine = await getState(remoteCtx("link-a"), lane);
    expect(mine.lane.ended?.reason).toBe("relaunched");
    expect((await getState(remoteCtx("link-b"), lane)).lane.ended).toBeNull();
    expect((await getState(localCtx(), lane)).lane.ended).toBeNull();
  });

  it("lets this machine's windows pause, while a remote window only sees the pause", async () => {
    expect(await setPaused(localCtx(), true)).toBe(true);
    expect(policy.isPaused()).toBe(true);
    expect(await setPaused(remoteCtx("link-a"), false)).toBe(true);
    expect(policy.isPaused()).toBe(true);
    expect((await getState(remoteCtx("link-a"), { projectId: "proj", slot: 0 })).paused).toBe(true);
    // The pause doesn't turn a lane off: it reads on to anyone viewing it.
    run(0, "s1");
    expect((await getState(localCtx(), { projectId: "proj", slot: 0 })).lane.enrolled).toBe(true);
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
    // This machine's own runs need no enrollment, by default or otherwise (#13468).
    expect(policy.enrollByDefault({ projectId: "proj", slot: 0 }, { kind: "local" })).toEqual({
      ok: false,
      reason: "wrong-session",
    });
    const off = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: false });
    expect(off.state.lane.enrolled).toBe(false);
    expect(
      policy.enrollByDefault(
        { projectId: "proj", slot: 0 },
        { kind: "remote", linkSessionId: "link-a" }
      )
    ).toEqual({ ok: false, reason: "declined" });
    // Turning it on again is the person's own choice and still works.
    const on = await setLaneEnrolled(localCtx(), { projectId: "proj", slot: 0, enrolled: true });
    expect(on.refusal).toBeNull();
    expect(on.state.lane.enrolled).toBe(true);
  });
});
