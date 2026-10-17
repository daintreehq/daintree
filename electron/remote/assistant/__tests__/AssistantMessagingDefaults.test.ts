import { describe, expect, it } from "vitest";
import type { RunningLane, RunningLaneSession } from "../../../services/HelpSessionService.js";
import { AssistantMessagingDefaults } from "../AssistantMessagingDefaults.js";
import { AssistantMessagingPolicy, type MessagingShell } from "../AssistantMessagingPolicy.js";

interface Run extends RunningLane {
  session: RunningLaneSession;
  view: MessagingShell | null;
}

function harness(options: { accepts?: boolean; platform?: string } = {}) {
  const runs: Run[] = [];
  const generations = new Map<string, number>();
  const startedBy = new Map<string, string>();
  let accepts = options.accepts ?? true;
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
  };
}

const LOCAL: MessagingShell = { kind: "local" };
const SHELL_A: MessagingShell = { kind: "remote", linkSessionId: "link-a" };
const SHELL_B: MessagingShell = { kind: "remote", linkSessionId: "link-b" };

describe("AssistantMessagingDefaults (#13441)", () => {
  it("never enrolls a run in one of this machine's own views, which needs no enrollment (#13468)", () => {
    const h = harness();
    h.run("proj", 0, LOCAL);
    h.run("proj", 1, LOCAL);
    h.run("other", 0, null);
    h.defaults.apply();
    expect(h.policy.listEnrollments()).toEqual([]);
  });

  it("enrolls each remote Shell's runs for that Shell, alongside this machine's own runs", () => {
    const h = harness();
    h.run("proj", 0, LOCAL);
    h.run("proj", 1, SHELL_A);
    h.run("other", 0, SHELL_B);
    h.policy.bindSender("link-a", "sender-a");
    h.policy.bindSender("link-b", "sender-b");
    h.defaults.apply();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 0 })).toBeNull();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 1 })?.enrolledBy).toEqual(SHELL_A);
    expect(h.policy.getEnrollment({ projectId: "other", slot: 0 })?.enrolledBy).toEqual(SHELL_B);
  });

  it("enrolls nothing while the saved default is off, and applies it once it's on", () => {
    const h = harness({ accepts: false });
    h.run("proj", 0, SHELL_A);
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.apply();
    expect(h.policy.listEnrollments()).toEqual([]);
    h.setAccepts(true);
    h.defaults.apply();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 0 })?.enrolledBy).toEqual(SHELL_A);
  });

  it("enrolls a run in a remote Shell's view for that Shell once it proved its sender", () => {
    const h = harness();
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
    h.run("proj", 0, SHELL_A, { attached: false });
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.apply();
    expect(h.policy.listEnrollments()).toEqual([]);
  });

  it("does nothing on Windows", () => {
    const h = harness({ platform: "win32" });
    h.run("proj", 0, SHELL_A);
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.apply();
    expect(h.policy.listEnrollments()).toEqual([]);
  });

  it("drops a pass already queued when it's disposed", async () => {
    const h = harness();
    h.run("proj", 0, SHELL_A);
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.schedule();
    h.defaults.dispose();
    await Promise.resolve();
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
    h.run("proj", 0, SHELL_A);
    h.policy.bindSender("link-a", "sender-a");
    h.defaults.schedule();
    h.defaults.schedule();
    await Promise.resolve();
    expect(passes).toBe(1);
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 0 })).not.toBeNull();

    h.run("proj", 1, SHELL_A);
    h.defaults.dispose();
    h.defaults.schedule();
    await Promise.resolve();
    expect(h.policy.getEnrollment({ projectId: "proj", slot: 1 })).toBeNull();
  });
});
