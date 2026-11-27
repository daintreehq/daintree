import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { HOST_WATCH_AGENTS_MAX } from "../../../../shared/types/hostControl.js";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { formatWorkerWaitLine } from "../../../services/mcp-server/noticeFormat.js";
import type { AgentWaitingHeard } from "../../metrics/agentWaiting.js";
import type { OpenRun } from "../HostCallRuntime.js";
import {
  WORKER_WAIT_ATTEMPTS_MAX,
  WORKER_WAIT_PENDING_MAX_MS,
  WORKER_WAIT_PENDING_RECHECK_MS,
  WORKER_WAIT_RETRY_MS,
  WORKER_WAIT_SETTLE_MS,
  WorkerWaitRoute,
  type OpenWait,
  type WaitCoverage,
} from "../workerWaitRoute.js";

function lane(projectId: string, slot: number, sessionId = `${projectId}-${slot}`): OpenRun {
  return { projectId, slot, sessionId, terminalId: `pane-${sessionId}`, launchGeneration: 1 };
}

const GLOBAL = lane(GLOBAL_ASSISTANT_ID, 0, "global");

function heard(terminalId: string, overrides: Partial<AgentWaitingHeard> = {}): AgentWaitingHeard {
  return {
    source: "event",
    terminalId,
    projectId: "proj-1",
    worktreeId: "/work/app",
    incarnation: 3,
    agentIncarnation: 0,
    waitingReason: "question",
    refined: false,
    seenAt: 1_000,
    ...overrides,
  };
}

describe("WorkerWaitRoute (#18279)", () => {
  let listener: ((terminalId: string, heard: AgentWaitingHeard | null) => void) | null;
  let receivers: Map<string, OpenRun>;
  let globalRun: OpenRun | null;
  let generations: Map<string, number>;
  let assistants: Set<string>;
  /** What requested notices say, by terminal, and the `since` each was asked with. */
  let notices: Map<string, WaitCoverage>;
  let noticeSince: number[];
  /** What the receiver's watches say, by session and terminal. */
  let watches: Map<string, WaitCoverage>;
  /** Sessions whose panes the person stopped. */
  let stopped: Set<string>;
  let queued: Array<{ lane: { helpSessionId: string }; wake: LaneWake }>;
  let openWaits: Promise<readonly OpenWait[]> | undefined;
  let ids: number;
  let route: WorkerWaitRoute;

  const make = () =>
    new WorkerWaitRoute({
      observe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      ...(openWaits !== undefined ? { readOpenWaits: () => openWaits! } : {}),
      isAssistantTerminal: (terminalId) => assistants.has(terminalId),
      liveGeneration: (terminalId) => generations.get(terminalId) ?? null,
      receiverFor: (projectId) => receivers.get(projectId) ?? globalRun,
      coveredByNotice: (terminalId, since) => {
        noticeSince.push(since);
        return notices.get(terminalId) ?? null;
      },
      coveredByWatch: (run, terminalId) => watches.get(`${run.sessionId}:${terminalId}`) ?? null,
      receiverStopped: (run) => stopped.has(run.sessionId),
      queueNotice: (target, wake) => queued.push({ lane: target, wake }),
      now: () => Date.now(),
      newId: () => `id-${++ids}`,
    });

  const hear = (terminalId: string, overrides: Partial<AgentWaitingHeard> = {}) =>
    listener?.(terminalId, heard(terminalId, overrides));
  const settle = () => vi.advanceTimersByTime(WORKER_WAIT_SETTLE_MS);
  const names = (entry: { wake: LaneWake } | undefined) =>
    entry?.wake.workerWaits?.agents.map((agent) => agent.terminalId);
  const typed = (entry: { wake: LaneWake }) => {
    expect(entry.wake.recheck()).toEqual({ kind: "ready" });
    expect(entry.wake.beforeType()).toBe(true);
    entry.wake.report({ kind: "delivered" });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    listener = null;
    receivers = new Map();
    globalRun = null;
    generations = new Map(Array.from({ length: 12 }, (_, i) => [`w${i + 1}`, 3]));
    assistants = new Set(["lead-pane"]);
    notices = new Map();
    noticeSince = [];
    watches = new Map();
    stopped = new Set();
    queued = [];
    openWaits = undefined;
    ids = 0;
    route = make();
  });

  afterEach(() => {
    route.dispose();
    vi.useRealTimers();
  });

  it("tells the project's lowest running lane once its settle holds", () => {
    receivers.set("proj-1", lane("proj-1", 2));
    hear("w1");
    vi.advanceTimersByTime(WORKER_WAIT_SETTLE_MS - 1);
    expect(queued).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].lane.helpSessionId).toBe("proj-1-2");
    expect(queued[0].wake.kind).toBe("worker-wait");
    expect(names(queued[0])).toEqual(["w1"]);
    expect(queued[0].wake.workerWaits?.global).toBe(false);
  });

  it("falls back to the global coordinator, naming the tool it reads with", () => {
    globalRun = GLOBAL;
    hear("w2");
    settle();
    expect(queued.map((entry) => entry.lane.helpSessionId)).toEqual(["global"]);
    const waits = queued[0].wake.workerWaits!;
    expect(waits.global).toBe(true);
    expect(formatWorkerWaitLine(waits.agents, waits.global)).toContain("host.status on local");
  });

  it("holds a wait nobody hears until an Assistant is seen starting", () => {
    hear("w1");
    settle();
    vi.advanceTimersByTime(60_000);
    expect(queued).toHaveLength(0);
    receivers.set("proj-1", lane("proj-1", 0));
    listener?.("lead-pane", null);
    vi.advanceTimersByTime(0);
    expect(names(queued[0])).toEqual(["w1"]);
  });

  it("tells one wait once, through its refinements, and a later wait again", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1", { waitingReason: "approval" });
    settle();
    typed(queued[0]);
    hear("w1", { waitingReason: "question", refined: true });
    settle();
    expect(queued).toHaveLength(1);
    listener?.("w1", null);
    hear("w1", { seenAt: 9_000 });
    settle();
    expect(queued).toHaveLength(2);
  });

  it("tells a prompt only once it becomes a question, counting coverage from then", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1", { waitingReason: "prompt", seenAt: 1_000 });
    settle();
    expect(queued).toHaveLength(0);
    hear("w1", { waitingReason: "question", refined: true, seenAt: 4_000 });
    settle();
    expect(queued).toHaveLength(1);
    expect(noticeSince).toEqual([4_000]);
    hear("w2");
    listener?.("w2", null);
    settle();
    expect(queued).toHaveLength(1);
  });

  it("never tells an assistant's own pane, a wait with no project, or one in the trash", () => {
    globalRun = GLOBAL;
    hear("lead-pane");
    hear("w2", { projectId: null });
    hear("w3");
    listener?.("w3", null);
    settle();
    expect(queued).toHaveLength(0);
  });

  it("leaves a wait another notice told, and looks again at one it may still tell", () => {
    const lead = lane("proj-1", 0);
    receivers.set("proj-1", lead);
    notices.set("w1", "told");
    watches.set(`${lead.sessionId}:w2`, "told");
    notices.set("w3", "pending");
    watches.set(`${lead.sessionId}:w4`, "pending");
    for (const id of ["w1", "w2", "w3", "w4", "w5"]) hear(id);
    settle();
    expect(queued.map(names)).toEqual([["w5"]]);

    // The requested notice went out; the watch's line was withdrawn before typing.
    notices.set("w3", "told");
    watches.set(`${lead.sessionId}:w4`, null);
    vi.advanceTimersByTime(WORKER_WAIT_PENDING_RECHECK_MS);
    expect(queued.map(names)).toEqual([["w5"], ["w4"]]);
  });

  it("tells a wait anyway once another pane's notice has only promised it for too long", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    notices.set("w1", "pending");
    notices.set("w2", "pending-here");
    vi.setSystemTime(1_000);
    hear("w1", { seenAt: 1_000 });
    hear("w2", { seenAt: 1_000 });
    vi.advanceTimersByTime(WORKER_WAIT_PENDING_MAX_MS - WORKER_WAIT_PENDING_RECHECK_MS);
    expect(queued).toHaveLength(0);
    vi.advanceTimersByTime(WORKER_WAIT_PENDING_RECHECK_MS * 2);
    // One the receiver's own pane will hear never goes out twice into it.
    expect(queued.map(names)).toEqual([["w1"]]);
  });

  it("never undoes the person's Stop on a receiver, even after another receiver fails it", () => {
    const first = lane("proj-1", 0);
    receivers.set("proj-1", first);
    hear("w1");
    settle();
    stopped.add(first.sessionId);
    queued[0].wake.report({ kind: "unavailable", reason: "stopped" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS * 3);
    listener?.("lead-pane", null);
    vi.advanceTimersByTime(0);
    expect(queued).toHaveLength(1);

    receivers.set("proj-1", lane("proj-1", 1));
    listener?.("lead-pane", null);
    vi.advanceTimersByTime(0);
    expect(queued.map((entry) => entry.lane.helpSessionId)).toEqual(["proj-1-0", "proj-1-1"]);
    // That one goes too, and the stopped one is what's left; the Stop still holds.
    stopped.delete(first.sessionId);
    receivers.set("proj-1", first);
    queued[1].wake.report({ kind: "unavailable", reason: "relaunched" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS * 3);
    listener?.("lead-pane", null);
    vi.advanceTimersByTime(0);
    expect(queued).toHaveLength(2);
  });

  it("never offers a wait to a receiver the person stopped while another notice held it", () => {
    const lead = lane("proj-1", 0);
    receivers.set("proj-1", lead);
    notices.set("w1", "pending-here");
    hear("w1");
    settle();
    // Stop cleared the receiver's own requested notice.
    stopped.add(lead.sessionId);
    notices.delete("w1");
    vi.advanceTimersByTime(WORKER_WAIT_PENDING_RECHECK_MS);
    expect(queued).toHaveLength(0);
  });

  it("offers a line stopped by anything but the person again later, as any refusal", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1");
    settle();
    // Daintree control turned off and on again: the same run hears it after the wait.
    queued[0].wake.report({ kind: "unavailable", reason: "stopped" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS);
    expect(queued).toHaveLength(2);
  });

  it("gathers the waits that settle together into lines per receiver, naming every one", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    globalRun = GLOBAL;
    const many = Array.from({ length: HOST_WATCH_AGENTS_MAX + 1 }, (_, i) => `w${i + 1}`);
    for (const id of many) hear(id);
    hear("w12", { projectId: "proj-2" });
    settle();
    expect(queued.map((entry) => [entry.lane.helpSessionId, names(entry)])).toEqual([
      ["proj-1-0", many.slice(0, HOST_WATCH_AGENTS_MAX)],
      ["proj-1-0", many.slice(HOST_WATCH_AGENTS_MAX)],
      ["global", ["w12"]],
    ]);
  });

  it("moves a queued wait to the project's own lane when one starts before it is typed", () => {
    globalRun = GLOBAL;
    hear("w1");
    hear("w3", { projectId: "proj-2" });
    settle();
    expect(queued).toHaveLength(1);
    receivers.set("proj-1", lane("proj-1", 1));
    expect(queued[0].wake.recheck()).toEqual({ kind: "ready" });
    expect(names(queued[0])).toEqual(["w3"]);
    vi.advanceTimersByTime(0);
    expect(queued).toHaveLength(2);
    expect(queued[1].lane.helpSessionId).toBe("proj-1-1");
    expect(names(queued[1])).toEqual(["w1"]);
  });

  it("drops a queued wait back at a plain prompt, and tells it if it asks again", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1", { waitingReason: "approval" });
    hear("w2");
    settle();
    hear("w1", { waitingReason: "prompt", refined: true });
    expect(queued[0].wake.beforeType()).toBe(true);
    expect(names(queued[0])).toEqual(["w2"]);
    hear("w1", { waitingReason: "question", refined: true });
    settle();
    expect(names(queued[1])).toEqual(["w1"]);
  });

  it("offers a line its receiver couldn't take to the next at once, and to it again later, a few times", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1");
    settle();
    queued[0].wake.report({ kind: "unavailable", reason: "capacity" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS - 1);
    expect(queued).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(queued).toHaveLength(2);

    receivers.set("proj-1", lane("proj-1", 1));
    queued[1].wake.report({ kind: "unavailable", reason: "relaunched" });
    vi.advanceTimersByTime(0);
    expect(queued.map((entry) => entry.lane.helpSessionId)).toEqual([
      "proj-1-0",
      "proj-1-0",
      "proj-1-1",
    ]);
    expect(queued).toHaveLength(WORKER_WAIT_ATTEMPTS_MAX);
    queued[2].wake.report({ kind: "unavailable", reason: "capacity" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS * 2);
    expect(queued).toHaveLength(WORKER_WAIT_ATTEMPTS_MAX);
  });

  it("offers again a line the host refused at admission, but never one perhaps written", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    receivers.set("proj-2", lane("proj-2", 0));
    hear("w1");
    hear("w2", { projectId: "proj-2" });
    settle();
    const [first, second] = queued;
    expect(first.wake.beforeType()).toBe(true);
    expect(second.wake.beforeType()).toBe(true);
    first.wake.report({ kind: "unavailable", reason: "line-refused" });
    second.wake.report({ kind: "ambiguous", reason: "unconfirmed" });
    vi.advanceTimersByTime(WORKER_WAIT_RETRY_MS);
    expect(queued.slice(2).map(names)).toEqual([["w1"]]);
  });

  it("types nothing for a wait whose pane was relaunched before its line", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1");
    settle();
    generations.set("w1", 4);
    expect(queued[0].wake.recheck()).toEqual({ kind: "unavailable", reason: "moved-on" });
    expect(queued[0].wake.beforeType()).toBe(false);
  });

  it("tells a wait already open when it started, unless its terminal was heard meanwhile", async () => {
    route.dispose();
    let resolve!: (waits: readonly OpenWait[]) => void;
    openWaits = new Promise((done) => (resolve = done));
    route = make();
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w2", { waitingReason: "prompt" });
    // Back at work while the read ran: its row is stale.
    listener?.("w3", null);
    const row = (terminalId: string): OpenWait => ({
      terminalId,
      projectId: "proj-1",
      incarnation: 3,
      waitingReason: "question",
      seenAt: null,
    });
    resolve([row("w1"), row("w2"), row("w3")]);
    await vi.advanceTimersByTimeAsync(WORKER_WAIT_SETTLE_MS);
    expect(queued.map(names)).toEqual([["w1"]]);
  });

  it("holds no timer while nothing is due, and nothing once disposed", () => {
    expect(vi.getTimerCount()).toBe(0);
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1");
    expect(vi.getTimerCount()).toBe(1);
    route.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toBeNull();
  });

  it("formats the line as observations, naming each worker and where", () => {
    receivers.set("proj-1", lane("proj-1", 0));
    hear("w1", { waitingReason: "approval", approvalKind: "trust" });
    settle();
    const line = formatWorkerWaitLine(queued[0].wake.workerWaits?.agents ?? []);
    expect(line).toContain("terminal w1 on this machine (project proj-1, worktree /work/app");
    expect(line).toContain("folder-trust prompt");
    expect(line).toContain("Sent unasked");
    expect(line).toContain("terminal.getStatus");
  });
});
