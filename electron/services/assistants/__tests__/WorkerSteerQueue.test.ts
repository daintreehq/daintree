import { beforeEach, describe, expect, it, vi } from "vitest";
import { stampPromptInput } from "../../../../shared/utils/terminalInputProvenance.js";
import type {
  LaneWake,
  NotifyTerminalInfo,
  OwnPane,
  PendingNotify,
} from "../../mcp-server/terminalNotify.js";
import { HoldRefusedError, WorkerSteerQueue, type HoldSteerRequest } from "../WorkerSteerQueue.js";

const PROJECT = "proj-1";
const WORKER = "term-worker";
const OWNER = "principal\u0000relay\u0000shell-1\u0000help-1";
const OTHER = "principal\u0000relay\u0000shell-1\u0000help-2";

describe("WorkerSteerQueue (#16187)", () => {
  let now: number;
  let generation: number | null;
  let projectOf: string | null;
  let wakes: Array<{ pane: OwnPane; projectId: string; wake: LaneWake }>;
  let enqueue: (pane: OwnPane, projectId: string, wake: LaneWake) => void;
  let tokens: number;
  let queue: WorkerSteerQueue;

  const atPrompt = (extra: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo => ({
    projectId: PROJECT,
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 5_000,
    hasPty: true,
    agentIncarnation: 2,
    agentSessionId: "sess-1",
    launchGeneration: 4,
    ...extra,
  });

  const request = (extra: Partial<HoldSteerRequest> = {}): HoldSteerRequest => ({
    principal: OWNER,
    projectId: PROJECT,
    terminalId: WORKER,
    generation: 4,
    run: { agentIncarnation: 2, agentSessionId: "sess-1" },
    text: "[stamped] Rebase onto develop",
    promptAsWritten: "Rebase onto develop",
    ttlSeconds: 1_800,
    authorize: () => null,
    isWriting: () => false,
    ...extra,
  });

  const lastWake = (): LaneWake => wakes.at(-1)!.wake;

  beforeEach(() => {
    now = 1_000;
    generation = 4;
    projectOf = PROJECT;
    wakes = [];
    tokens = 0;
    enqueue = (pane, projectId, wake) => wakes.push({ pane, projectId, wake });
    queue = new WorkerSteerQueue({
      enqueueWake: (pane, projectId, wake) => enqueue(pane, projectId, wake),
      paneFor: (terminalId) => ({ key: `pane\u0000worker-principal`, terminalId }),
      getLiveGeneration: () => generation,
      getTerminalProjectId: () => projectOf,
      now: () => now,
      newToken: () => `tok-${++tokens}`,
    });
  });

  it("queues a steer wake on the worker's own notice line, carrying its prompt and lifetime", () => {
    const held = queue.hold(request({ handbackCode: "hb-1", ttlSeconds: 600 }));

    expect(held).toEqual({ queuedSendToken: "tok-1", expiresAt: 601_000 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.pane).toEqual({ key: "pane\u0000worker-principal", terminalId: WORKER });
    expect(wakes[0]!.projectId).toBe(PROJECT);
    expect(lastWake()).toMatchObject({
      id: "tok-1",
      kind: "steer",
      steer: {
        text: "[stamped] Rebase onto develop",
        promptAsWritten: "Rebase onto develop",
        handbackCode: "hb-1",
      },
      maxPendingMs: 600_000,
    });
    expect(queue.status(OWNER, "tok-1")).toMatchObject({
      status: "queued",
      queuedAt: 1_000,
      expiresAt: 601_000,
      waitingOn: "working",
    });
  });

  it("holds while the worker works, at a question or an approval, and goes at its exact prompt", () => {
    queue.hold(request());
    const wake = lastWake();

    expect(wake.recheck(atPrompt({ agentState: "working" }))).toEqual({
      kind: "held",
      reason: "working",
    });
    expect(wake.recheck(atPrompt({ waitingReason: "question" }))).toEqual({
      kind: "held",
      reason: "question",
    });
    expect(wake.recheck(atPrompt({ waitingReason: "approval" }))).toEqual({
      kind: "held",
      reason: "approval",
    });
    expect(queue.status(OWNER, "tok-1")?.waitingOn).toBe("approval");
    expect(wake.recheck(atPrompt())).toEqual({ kind: "ready" });
  });

  it("waits while a live steer writes to the worker", () => {
    let writing = true;
    queue.hold(request({ isWriting: () => writing }));

    expect(lastWake().recheck(atPrompt())).toEqual({ kind: "held", reason: "writing" });
    writing = false;
    expect(lastWake().recheck(atPrompt())).toEqual({ kind: "ready" });
  });

  it("drops on someone else's prompt-capable input since it was held, never on its own sender's", () => {
    const run = { agentIncarnation: 2, agentSessionId: "sess-1" };
    stampPromptInput(run, 900);
    queue.hold(request({ run }));
    const wake = lastWake();

    // What was typed before it was held is the baseline, and its sender's own keys pass.
    const info = atPrompt({ lastForeignPromptInputAt: 900 });
    stampPromptInput(info, 1_100, OWNER);
    expect(wake.recheck(info)).toEqual({ kind: "ready" });

    stampPromptInput(info, 1_200);
    expect(wake.recheck(info)).toEqual({ kind: "unavailable", reason: "typed" });
    expect(queue.status(OWNER, "tok-1")).toMatchObject({ status: "dropped", reason: "typed" });
  });

  it("drops another assistant's keys as someone else's", () => {
    queue.hold(request());
    const info = atPrompt();
    stampPromptInput(info, 1_100, OTHER);

    expect(lastWake().recheck(info)).toEqual({ kind: "unavailable", reason: "typed" });
  });

  it.each([
    ["a new launch generation", () => (generation = 5), atPrompt(), "restarted"],
    ["a new agent incarnation", () => {}, atPrompt({ agentIncarnation: 3 }), "restarted"],
    ["a changed agent session", () => {}, atPrompt({ agentSessionId: "sess-2" }), "restarted"],
    ["another worktree", () => {}, atPrompt({ worktreeId: "wt-2" }), "restarted"],
    ["an exit", () => {}, atPrompt({ isExited: true }), "target-gone"],
    ["the trash", () => {}, atPrompt({ isTrashed: true }), "target-gone"],
    ["another project", () => (projectOf = "proj-2"), atPrompt(), "target-gone"],
  ] as const)("drops on %s", (_label, change, info, reason) => {
    queue.hold(request());
    change();

    expect(lastWake().recheck(info)).toEqual({ kind: "unavailable", reason });
    expect(queue.status(OWNER, "tok-1")).toMatchObject({ status: "dropped", reason });
  });

  it("drops once its time runs out, read or rechecked", () => {
    queue.hold(request({ ttlSeconds: 60 }));
    now = 61_000;

    expect(queue.status(OWNER, "tok-1")).toMatchObject({ status: "dropped", reason: "expired" });
    expect(lastWake().recheck(atPrompt())).toMatchObject({ kind: "unavailable" });
  });

  it("asks its deferred authority right before the line, dropping it unwritten when refused", () => {
    let refusal: { code: string; message: string } | null = null;
    queue.hold(request({ authorize: () => refusal }));
    refusal = { code: "DRIVEN_ELSEWHERE", message: "driven elsewhere" };

    expect(lastWake().beforeType()).toBe(false);
    expect(queue.status(OWNER, "tok-1")).toMatchObject({
      status: "dropped",
      reason: "not-allowed",
    });
  });

  it("reports delivered with the host's write and completes the notice with the line's token", () => {
    const notice: PendingNotify = { complete: vi.fn(), cancel: vi.fn() };
    queue.hold(request({ takeNotice: () => notice }));
    const wake = lastWake();

    expect(wake.beforeType()).toBe(true);
    now = 9_000;
    wake.report({ kind: "delivered" }, { phase: "pty_written", submissionToken: "line-1" });

    expect(queue.status(OWNER, "tok-1")).toMatchObject({
      status: "delivered",
      submissionToken: "line-1",
      endedAt: 9_000,
    });
    expect(notice.complete).toHaveBeenCalledWith({ submissionToken: "line-1" });
    expect(notice.cancel).not.toHaveBeenCalled();
  });

  it("reports a line the host never confirmed as unconfirmed, and its notice goes", () => {
    const notice: PendingNotify = { complete: vi.fn(), cancel: vi.fn() };
    queue.hold(request({ takeNotice: () => notice }));
    lastWake().beforeType();
    lastWake().report({ kind: "ambiguous", reason: "unconfirmed" });

    expect(queue.status(OWNER, "tok-1")?.status).toBe("unconfirmed");
    expect(notice.cancel).toHaveBeenCalledOnce();
    expect(notice.complete).not.toHaveBeenCalled();
  });

  it("reads an engine expiry or stop as dropped", () => {
    queue.hold(request());
    lastWake().report({ kind: "unavailable", reason: "expired" });
    expect(queue.status(OWNER, "tok-1")).toMatchObject({ status: "dropped", reason: "expired" });

    queue.hold(request());
    lastWake().report({ kind: "unavailable", reason: "stopped" });
    expect(queue.status(OWNER, "tok-2")).toMatchObject({ status: "dropped", reason: "stopped" });
  });

  it("keeps one held prompt per sender and worker: a newer one supersedes the older", () => {
    const first: PendingNotify = { complete: vi.fn(), cancel: vi.fn() };
    queue.hold(request({ takeNotice: () => first }));
    const firstWake = lastWake();

    const second = queue.hold(request({ text: "second" }));

    expect(second.supersededToken).toBe("tok-1");
    expect(queue.status(OWNER, "tok-1")).toMatchObject({
      status: "superseded",
      supersededBy: "tok-2",
    });
    expect(first.cancel).toHaveBeenCalledOnce();
    // Its wake leaves the line at its next check, untyped.
    expect(firstWake.recheck(atPrompt())).toMatchObject({ kind: "unavailable" });
    expect(firstWake.beforeType()).toBe(false);
    expect(queue.status(OWNER, "tok-2")?.status).toBe("queued");
  });

  it("leaves another sender's held prompt to the same worker alone", () => {
    queue.hold(request());
    const other = queue.hold(request({ principal: OTHER }));

    expect(other.supersededToken).toBeUndefined();
    expect(queue.status(OWNER, "tok-1")?.status).toBe("queued");
    expect(queue.status(OTHER, "tok-2")?.status).toBe("queued");
  });

  it("refuses when the worker's line can't take it, leaving the older held prompt in place", () => {
    queue.hold(request());
    enqueue = (_pane, _projectId, wake) => wake.report({ kind: "unavailable", reason: "capacity" });

    expect(() => queue.hold(request())).toThrow(HoldRefusedError);
    expect(queue.status(OWNER, "tok-1")?.status).toBe("queued");
    expect(queue.status(OWNER, "tok-2")).toBeNull();
  });

  it("refuses one the engine drops at once, never handing back a token", () => {
    generation = 9;
    enqueue = (pane, projectId, wake) => {
      wakes.push({ pane, projectId, wake });
      wake.recheck();
    };
    const take = vi.fn();

    expect(() => queue.hold(request({ takeNotice: take }))).toThrow(/restarted/);
    expect(take).not.toHaveBeenCalled();
    expect(lastWake().beforeType()).toBe(false);
  });

  it("cancels only for its own sender, and only while it hasn't reached the line", () => {
    const notice: PendingNotify = { complete: vi.fn(), cancel: vi.fn() };
    queue.hold(request({ takeNotice: () => notice }));

    expect(queue.cancel(OTHER, WORKER, "tok-1")).toBeNull();
    expect(queue.cancel(OWNER, "term-other", "tok-1")).toBeNull();
    expect(queue.status(OTHER, "tok-1")).toBeNull();
    expect(queue.cancel(OWNER, WORKER, "tok-1")).toMatchObject({
      cancelled: true,
      record: { status: "cancelled" },
    });
    expect(notice.cancel).toHaveBeenCalledOnce();
    expect(lastWake().beforeType()).toBe(false);

    queue.hold(request());
    lastWake().beforeType();
    expect(queue.cancel(OWNER, WORKER, "tok-2")).toMatchObject({
      cancelled: false,
      record: { status: "queued" },
    });
  });

  it("drops what an ended session held, and nothing another session holds", () => {
    queue.hold(request());
    queue.hold(request({ principal: OTHER }));

    queue.revokePrincipal(OWNER);

    expect(queue.status(OWNER, "tok-1")).toMatchObject({
      status: "dropped",
      reason: "session-gone",
    });
    expect(queue.status(OTHER, "tok-2")?.status).toBe("queued");
    expect(wakes[0]!.wake.beforeType()).toBe(false);
  });

  it("refuses to hold anything once disposed, and drops what it held", () => {
    queue.hold(request());
    queue.dispose();

    expect(queue.status(OWNER, "tok-1")).toMatchObject({ status: "dropped", reason: "stopped" });
    expect(() => queue.hold(request())).toThrow(HoldRefusedError);
  });

  it("clamps the time a caller asks for to the bounds", () => {
    expect(queue.hold(request({ ttlSeconds: 5 })).expiresAt).toBe(61_000);
    expect(queue.hold(request({ ttlSeconds: 99_999, principal: OTHER })).expiresAt).toBe(3_601_000);
  });
});
