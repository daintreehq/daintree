import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { AssistantHostProcess } from "../../../electron/services/assistant-host/AssistantHostProcess.js";
import type { AssistantHostSessionDescriptor } from "@shared/types/ipc/assistantHost";
import { ASSISTANT_HOST_PROTOCOL_VERSION } from "@shared/types/ipc/assistantHost";
import { useAssistantStore, selectTurnToolCalls } from "../assistantStore";

/**
 * WHOLE-PIPELINE integration: a real engine process, the real transport, the real
 * validator, and the real reducer.
 *
 * Every other test in this area covers one seam. This covers the joins between them,
 * which is where the interesting failures live — a field the schema requires but the
 * engine omits, a reducer that mishandles an event shape that validates fine, an
 * ordering assumption that only breaks when frames actually arrive over a pipe.
 *
 * The engine here is the scriptable fake (`e2e/helpers/fake-assistant-engine.mjs`), so
 * each scenario is an exact byte sequence rather than whatever a model happened to
 * say. It is separately proven faithful to the real Go engine's shapes by
 * `e2e/helpers/__tests__/fakeAssistantEngine.test.ts`.
 */

const ENGINE = path.resolve(__dirname, "../../../e2e/helpers/fake-assistant-engine.mjs");

/**
 * Upper bound on one scripted run. The fake engine runs at zero delay, so a run that
 * reaches this has hung rather than been slow — the bound exists to fail the test
 * instead of the suite timing out with no attribution.
 */
const RUN_TIMEOUT_MS = 10_000;

const DESCRIPTOR: AssistantHostSessionDescriptor = {
  sessionId: "ses_pipeline",
  windowId: 1,
  projectId: "p_pipeline",
  cwd: "/tmp",
  tier: "system",
  protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
};

interface RunOptions {
  scenario: string;
  prompt?: string;
  /** Answers the first approval the run parks on. */
  approve?: "approved" | "rejected";
  /** Sent after the first turn ends, to exercise a second exchange. */
  then?: string;
}

/**
 * Drives one session to completion, reducing every event into the real store, and
 * returns the resulting state.
 */
async function runPipeline(opts: RunOptions) {
  const store = useAssistantStore.getState();
  store.reset(DESCRIPTOR.sessionId);

  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let turnsEnded = 0;
  const expectedTurns = opts.then ? 2 : 1;

  const host = new AssistantHostProcess({
    // Spawned directly: the fake carries a `#!/usr/bin/env node` shebang and the
    // executable bit, so it runs exactly the way the real Go binary does — no node
    // wrapper, no special-casing in the class under test. The `host --stdio` args the
    // class appends are accepted and ignored.
    binaryPath: ENGINE,
    descriptor: DESCRIPTOR,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_ENGINE_SCENARIO: opts.scenario,
      FAKE_ENGINE_SPEED: "0",
    } as Record<string, string>,
    onEvent: (event) => {
      useAssistantStore.getState().applyEvent(event);

      if (event.type === "approval:requested" && opts.approve) {
        host.send({
          type: "approval:decide",
          sessionId: DESCRIPTOR.sessionId,
          approvalId: event.approvalId,
          decision: opts.approve,
        });
      }
      if (event.type === "turn:end") {
        turnsEnded += 1;
        if (turnsEnded === 1 && opts.then) {
          useAssistantStore.getState().appendUserTurn(opts.then);
          host.send({ type: "prompt", sessionId: DESCRIPTOR.sessionId, text: opts.then });
        }
        if (turnsEnded >= expectedTurns) resolveDone();
      }
    },
    onSequenceGap: ({ missing }) => useAssistantStore.getState().recordGap(missing),
  });

  host.start();
  await host.waitForReady();

  const prompt = opts.prompt ?? "go";
  useAssistantStore.getState().appendUserTurn(prompt);
  host.send({ type: "prompt", sessionId: DESCRIPTOR.sessionId, text: prompt });

  await Promise.race([done, new Promise((r) => setTimeout(r, RUN_TIMEOUT_MS))]);
  host.dispose();
  return useAssistantStore.getState();
}

describe("assistant pipeline (fake engine → transport → schema → store)", () => {
  beforeEach(() => {
    useAssistantStore.getState().reset(null);
  });

  it("reaches ready and reports the engine build", async () => {
    const state = await runPipeline({ scenario: "simple" });
    expect(state.connection).toBe("ready");
    expect(state.engineVersion).toBe("fake-engine-1.0.0");
    expect(state.autoApprove).toBe(false);
  }, 20_000);

  it("builds a transcript with the user prompt and the streamed answer", async () => {
    const state = await runPipeline({ scenario: "simple", prompt: "which worktrees?" });
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ role: "user", text: "which worktrees?" });
    expect(state.turns[1]?.role).toBe("assistant");
    expect(state.turns[1]?.complete).toBe(true);
    expect(state.turns[1]?.text).toContain("Three worktrees are ready");
  }, 20_000);

  it("REPLACES streamed tokens with the authoritative turn:end content", async () => {
    // The v3 self-healing property. A consumer that merely concatenates tokens keeps
    // the truncated stream and shows corrupted prose forever; this asserts the
    // authoritative body wins.
    const state = await runPipeline({ scenario: "authoritativeContent" });
    const answer = state.turns.find((t) => t.role === "assistant");
    expect(answer?.text).toBe("The authoritative answer replaced the streamed text.");
    expect(answer?.text).not.toContain("PARTIAL-STREAM-SHOULD-BE-REPLACED");
  }, 20_000);

  it("surfaces a dropped frame instead of swallowing it", async () => {
    const state = await runPipeline({ scenario: "droppedFrame" });
    expect(state.droppedFrames).toBeGreaterThan(0);
    expect(state.notices.some((n) => /lost in transit/i.test(n.message))).toBe(true);
  }, 20_000);

  it("renders a tool batch as a plan, then settles each call", async () => {
    const state = await runPipeline({ scenario: "streaming" });
    const turn = state.turns.find((t) => t.role === "assistant")!;
    const calls = selectTurnToolCalls(state, turn);

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolId)).toEqual(["worktree.list", "git.getProjectPulse"]);
    for (const call of calls) expect(call.state).toBe("done");
    expect(state.usage?.contextTokens).toBe(31_200);
    expect(state.cost).toMatchObject({ total: 0.0412, complete: true });
  }, 20_000);

  it("carries needsTypedConfirm through to the approval, then completes on approve", async () => {
    const state = await runPipeline({ scenario: "approval", approve: "approved" });
    // The approval is gone once decided...
    expect(state.approvals).toHaveLength(0);
    const turn = state.turns.find((t) => t.role === "assistant")!;
    expect(turn.text).toContain("Pushed");
    expect(selectTurnToolCalls(state, turn)[0]?.state).toBe("done");
  }, 20_000);

  it("marks the tool failed when the approval is declined", async () => {
    const state = await runPipeline({ scenario: "approval", approve: "rejected" });
    const turn = state.turns.find((t) => t.role === "assistant")!;
    const call = selectTurnToolCalls(state, turn)[0];
    expect(call?.state).toBe("failed");
    expect(call?.errorCode).toBe("USER_DECLINED");
    expect(turn.text).toContain("Nothing was pushed");
  }, 20_000);

  it("keeps an accepted async call out of the done state", async () => {
    // The call settled but the work continues. Showing it as finished would claim
    // work completed that is still running.
    const state = await runPipeline({ scenario: "asyncWork" });
    const turn = state.turns.find((t) => t.role === "assistant")!;
    const call = selectTurnToolCalls(state, turn)[0];
    expect(call?.asyncId).toBe("asy_1");
    expect(call?.state).toBe("active");
  }, 20_000);

  it("records degraded conditions as standing state", async () => {
    const state = await runPipeline({ scenario: "degraded" });
    expect(state.rateLimited).toBe(true);
    expect(state.notices.some((n) => n.level === "warning")).toBe(true);
    // An incomplete cost is a FLOOR and must stay flagged as one.
    expect(state.cost).toMatchObject({ complete: false });
  }, 20_000);

  it("attaches reasoning to its turn without mixing it into the answer", async () => {
    const state = await runPipeline({ scenario: "reasoning" });
    const turn = state.turns.find((t) => t.role === "assistant")!;
    expect(turn.reasoning).toContain("list them before answering");
    expect(turn.text).not.toContain("list them before answering");
  }, 20_000);

  it("surfaces a turn error as a notice and still closes the turn", async () => {
    const state = await runPipeline({ scenario: "error" });
    expect(state.notices.some((n) => n.level === "error")).toBe(true);
    expect(state.turns.find((t) => t.role === "assistant")?.complete).toBe(true);
  }, 20_000);
});

describe("async tool rows survive the engine's trailing done", () => {
  it("keeps an accepted async call active after tool:state(done)", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    const base = { sessionId: "s1", turnId: "t1" } as const;
    store.applyEvent({
      ...base,
      seq: 1,
      type: "tool:batch",
      calls: [
        { toolCallId: "c1", toolId: "agentTask.spawnForEdits", argsSummary: "{}", danger: true },
      ],
    } as never);
    store.applyEvent({
      ...base,
      seq: 2,
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "agentTask.spawnForEdits",
      durationMs: 1200,
      result: "success",
      severity: "info",
      asyncId: "asy_1",
    } as never);
    expect(useAssistantStore.getState().toolCalls["c1"]?.state).toBe("active");

    // The real engine emits this for every successful result. Before the guard it
    // overwrote the row to "done", reporting a just-spawned agent as finished.
    store.applyEvent({
      ...base,
      seq: 3,
      type: "tool:state",
      toolCallId: "c1",
      state: "done",
    } as never);
    expect(useAssistantStore.getState().toolCalls["c1"]?.state).toBe("active");

    // A real failure still moves it — the guard is not a blanket ignore.
    store.applyEvent({
      ...base,
      seq: 4,
      type: "tool:state",
      toolCallId: "c1",
      state: "failed",
    } as never);
    expect(useAssistantStore.getState().toolCalls["c1"]?.state).toBe("failed");
  });
});

describe("mid-turn input is moved into the turn, not copied beside it", () => {
  function startAssistantTurn(store: ReturnType<typeof useAssistantStore.getState>) {
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
  }

  it("queues text typed during a turn and clears it once the engine folds it in", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    startAssistantTurn(store);

    expect(store.appendUserTurn("also check the tests")).toBeNull();
    expect(useAssistantStore.getState().queuedInterjection).toBe("also check the tests");
    // Critically: NOT a second user turn. Appending one here is what showed the same
    // message twice, the second time below the answer it was meant to steer.
    expect(useAssistantStore.getState().turns.filter((t) => t.role === "user")).toHaveLength(0);

    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "turn:interjection",
      turnId: "t1",
      text: "also check the tests",
    } as never);

    const after = useAssistantStore.getState();
    expect(after.queuedInterjection).toBeNull();
    expect(after.turns[0]?.interjections).toEqual(["also check the tests"]);
    expect(after.turns.filter((t) => t.role === "user")).toHaveLength(0);
  });

  it("promotes text the turn ended without ever folding in", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    startAssistantTurn(store);
    store.appendUserTurn("never folded in");

    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "answered",
    } as never);

    const after = useAssistantStore.getState();
    expect(after.queuedInterjection).toBeNull();
    // Shown late rather than lost: dropping something the user typed is worse.
    expect(after.turns.at(-1)).toMatchObject({ role: "user", text: "never folded in" });
  });

  it("still appends a normal user turn when nothing is running", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    expect(store.appendUserTurn("first message")).toMatch(/^local_/);
    expect(useAssistantStore.getState().queuedInterjection).toBeNull();
    expect(useAssistantStore.getState().turns).toHaveLength(1);
  });
});

describe("a turn keeps the order it happened in", () => {
  function ev(store: ReturnType<typeof useAssistantStore.getState>, e: Record<string, unknown>) {
    store.applyEvent({ sessionId: "s1", seq: 1, ...e } as never);
  }

  it("preserves prose written BEFORE a tool call", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, { type: "turn:start", turnId: "t1", role: "assistant", startedAt: 1 });
    ev(store, { type: "turn:token", turnId: "t1", chunk: "Let me check the worktrees." });
    ev(store, {
      type: "tool:batch",
      turnId: "t1",
      calls: [{ toolCallId: "c1", toolId: "worktree.list", argsSummary: "{}", danger: false }],
    });
    ev(store, { type: "turn:token", turnId: "t1", chunk: "There are three." });
    // The engine's authoritative content is the FINAL ROUND only — it hands
    // AssistantEnd `result.Message.Content`, not the whole turn.
    ev(store, {
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "answered",
      content: "There are three worktrees.",
    });

    const turn = useAssistantStore.getState().turns[0]!;
    expect(turn.segments.map((seg) => seg.kind)).toEqual(["text", "tools", "text"]);
    // The opening line survives. Replacing the whole turn with the final round's
    // content deleted the part that explained why the tool was called.
    expect(turn.segments[0]).toEqual({ kind: "text", text: "Let me check the worktrees." });
    // And the final round is corrected to the authoritative text.
    expect(turn.segments[2]).toEqual({ kind: "text", text: "There are three worktrees." });
  });

  it("places an interjection where the engine folded it in", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, { type: "turn:start", turnId: "t1", role: "assistant", startedAt: 1 });
    ev(store, { type: "turn:token", turnId: "t1", chunk: "Starting." });
    ev(store, { type: "turn:interjection", turnId: "t1", text: "use main instead" });
    ev(store, { type: "turn:token", turnId: "t1", chunk: " Using main." });

    const turn = useAssistantStore.getState().turns[0]!;
    expect(turn.segments.map((seg) => seg.kind)).toEqual(["text", "interjection", "text"]);
  });

  it("still exposes the whole answer as joined text", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, { type: "turn:start", turnId: "t1", role: "assistant", startedAt: 1 });
    ev(store, { type: "turn:token", turnId: "t1", chunk: "one " });
    ev(store, {
      type: "tool:batch",
      turnId: "t1",
      calls: [{ toolCallId: "c1", toolId: "x", argsSummary: "{}", danger: false }],
    });
    ev(store, { type: "turn:token", turnId: "t1", chunk: "two" });
    expect(useAssistantStore.getState().turns[0]?.text).toBe("one two");
  });
});
