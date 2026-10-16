import { describe, expect, it } from "vitest";
import type { RunningLane, RunningLaneSession } from "../../../services/HelpSessionService.js";
import { AssistantMessagingDefaults } from "../AssistantMessagingDefaults.js";
import { AssistantMessagingPolicy, type MessagingShell } from "../AssistantMessagingPolicy.js";

interface Run extends RunningLane {
  session: RunningLaneSession;
  view: MessagingShell | null;
}

function harness(options: { accepts?: boolean; messagingHost?: boolean; platform?: string } = {}) {
  const runs: Run[] = [];
  const generations = new Map<string, number>();
  const startedBy = new Map<string, string>();
  let accepts = options.accepts ?? true;
  let messagingHost = options.messagingHost ?? true;
  const find = (projectId: string, slot: number) =>
    runs.find((run) => run.projectId === projectId && run.slot === slot);
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) => find(projectId, slot)?.session ?? null,
    startedThrough: (session, linkSessionId) => startedBy.get(session.sessionId) === linkSessionId,
    getLiveGeneration: (terminalId) => generations.get(terminalId) ?? null,
    isHostMessagingEnabled: () => true,
    onSessionEnded: () => () => {},
    platform: (options.platform ?? "darwin") as NodeJS.Platform,
  });
  const defaults = new AssistantMessagingDefaults({
    policy,
    listRunningLanes: () =>
      runs.map(({ projectId, slot, agentId, attached }) => ({
        projectId,
        slot,
        agentId,
        attached,
      })),
    getRunningLaneSession: (projectId, slot) => find(projectId, slot)?.session ?? null,
    viewShell: (running) => runs.find((run) => run.session === running)?.view ?? null,
    acceptsByDefault: () => accepts,
    hasMessagingHost: () => messagingHost,
  });
  const run = (
    projectId: string,
    slot: number,
    view: MessagingShell | null,
    extra: Partial<RunningLane> = {}
  ) => {
    const sessionId = `s-${projectId}-${slot}`;
    const terminalId = `t-${projectId}-${slot}`;
    runs.push({
      projectId,
      slot,
      agentId: "claude",
      attached: true,
      ...extra,
      session: { sessionId, terminalId, projectViewWebContentsId: 1 },
      view,
    });
    generations.set(terminalId, 1);
    if (view?.kind === "remote") startedBy.set(sessionId, view.linkSessionId);
  };
  return {
    policy,
    defaults,
    run,
    setAccepts: (next: boolean) => (accepts = next),
    setMessagingHost: (next: boolean) => (messagingHost = next),
  };
}

const LOCAL: MessagingShell = { kind: "local" };
const SHELL_A: MessagingShell = { kind: "remote", linkSessionId: "link-a" };

describe("AssistantMessagingDefaults (#13441)", () => {
  it("makes the earliest running lane in one of this machine's views the hub", () => {
    const h = harness();
    h.run("other", 0, null);
    h.run("proj", 1, LOCAL);
    h.run("proj", 0, LOCAL);
    h.defaults.apply();
    expect(h.policy.getHub()).toMatchObject({ projectId: "proj", slot: 1 });
    expect(h.policy.listEnrollments()).toHaveLength(1);
  });

  it("enrolls nothing while the saved default is off, and applies it once it's on", () => {
    const h = harness({ accepts: false });
    h.run("proj", 0, LOCAL);
    h.defaults.apply();
    expect(h.policy.getHub()).toBeNull();
    h.setAccepts(true);
    h.defaults.apply();
    expect(h.policy.getHub()).not.toBeNull();
  });

  it("makes no hub until this Shell has messaging on for a host", () => {
    const h = harness({ messagingHost: false });
    h.run("proj", 0, LOCAL);
    h.defaults.apply();
    expect(h.policy.getHub()).toBeNull();
    h.setMessagingHost(true);
    h.defaults.apply();
    expect(h.policy.getHub()).not.toBeNull();
  });

  it("enrolls a run in a remote Shell's view for that Shell once it proved its sender", () => {
    const h = harness({ messagingHost: false });
    h.run("proj", 0, SHELL_A);
    h.defaults.apply();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.apply();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 0 })).toMatchObject({
      enrolledBy: SHELL_A,
    });
  });

  it("skips a run waiting for a view", () => {
    const h = harness();
    h.run("proj", 0, LOCAL, { attached: false });
    h.defaults.apply();
    expect(h.policy.getHub()).toBeNull();
  });

  it("does nothing on Windows", () => {
    const h = harness({ platform: "win32" });
    h.run("proj", 0, LOCAL);
    h.defaults.apply();
    expect(h.policy.listEnrollments()).toEqual([]);
  });

  it("coalesces passes to one per tick and stops after disposal", async () => {
    const h = harness();
    let passes = 0;
    const apply = h.defaults.apply.bind(h.defaults);
    h.defaults.apply = () => {
      passes++;
      apply();
    };
    h.run("proj", 0, LOCAL);
    h.defaults.schedule();
    h.defaults.schedule();
    await Promise.resolve();
    expect(passes).toBe(1);
    expect(h.policy.getHub()).not.toBeNull();

    h.run("proj", 1, SHELL_A);
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.dispose();
    h.defaults.schedule();
    await Promise.resolve();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 1 })).toBeNull();
  });
});
