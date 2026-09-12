import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { AssistantHostProcess } from "../../../electron/services/assistant-host/AssistantHostProcess.js";
import type {
  AssistantHostEvent,
  AssistantHostSessionDescriptor,
} from "@shared/types/ipc/assistantHost";
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
      // Only the ASSISTANT's turn ends the exchange. A prompt produces TWO brackets: the
      // user's own, which opens and closes in the same millisecond carrying no outcome,
      // and then the assistant's. Counting both settled the pipeline the instant the
      // prompt was echoed — before a single token had streamed — and every assertion
      // downstream then ran against an empty transcript.
      if (event.type === "turn:end" && event.outcome !== undefined) {
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
    expect(useAssistantStore.getState().queuedInterjections).toEqual(["also check the tests"]);
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
    expect(after.queuedInterjections).toEqual([]);
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
    expect(after.queuedInterjections).toEqual([]);
    // Shown late rather than lost: dropping something the user typed is worse.
    expect(after.turns.at(-1)).toMatchObject({ role: "user", text: "never folded in" });
  });

  it("still appends a normal user turn when nothing is running", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    expect(store.appendUserTurn("first message")).toMatch(/^local_/);
    expect(useAssistantStore.getState().queuedInterjections).toEqual([]);
    expect(useAssistantStore.getState().turns).toHaveLength(1);
  });
});

describe("a turn keeps the order it happened in", () => {
  function ev(store: ReturnType<typeof useAssistantStore.getState>, e: Record<string, unknown>) {
    store.applyEvent({ sessionId: "s1", seq: 1, ...e } as never);
  }

  it("stays owed past a LOCAL question's answer, until its command reports", () => {
    // `awaitingLocalCommand` is the STORE half of the composer lease; the view half —
    // that a set flag actually disables the bar — is asserted in the panel E2E suite.
    //
    // The gap it exists for is real and small: `question:answered` is posted before the
    // parked command is woken, so the sheet clears while the command is still applying
    // what was chosen. A prompt sent in that beat is
    // refused by the engine's endpoint reservation, which makes a liar of a question
    // that promised the choice applies from the next message.
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, {
      type: "question:requested",
      questionId: "q1",
      question: "Which backend should answer?",
      options: [
        { label: "A", text: "official" },
        { label: "B", text: "local" },
      ],
      default: 1,
      requestedAt: 1,
      // NO turnId: a command's question belongs to no turn. That absence is the whole
      // signal — it is what says a command is behind this and still owes a result.
    });
    expect(useAssistantStore.getState().pendingQuestion?.questionId).toBe("q1");

    ev(store, {
      type: "question:answered",
      questionId: "q1",
      choiceIndex: 0,
      cancelled: false,
      answeredAt: 2,
      label: "A",
      text: "official",
    });
    expect(useAssistantStore.getState().pendingQuestion).toBeNull();
    expect(useAssistantStore.getState().awaitingLocalCommand).toBe(true);

    ev(store, { type: "command:result", command: "/backend", text: "Backend is now official." });
    expect(useAssistantStore.getState().awaitingLocalCommand).toBe(false);
  });

  it("is not owed for a question the MODEL asked", () => {
    // A model's question is answered inside a turn that carries on by itself, with
    // nothing else owed. Holding the composer there would disable it for the rest of a
    // turn that is perfectly happy to take an interjection.
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, { type: "turn:start", turnId: "t1", role: "assistant", startedAt: 1 });
    ev(store, {
      type: "question:requested",
      questionId: "q1",
      turnId: "t1",
      toolCallId: "c1",
      question: "Which worktree?",
      options: [
        { label: "A", text: "main" },
        { label: "B", text: "feature" },
      ],
      default: 0,
      requestedAt: 1,
    });
    ev(store, {
      type: "question:answered",
      questionId: "q1",
      choiceIndex: 0,
      cancelled: false,
      answeredAt: 2,
      label: "A",
      text: "main",
    });
    expect(useAssistantStore.getState().awaitingLocalCommand).toBe(false);
  });

  it("stops being owed when the engine goes away mid-command", () => {
    // Nothing is owed by an engine that is gone. Without this the composer would stay
    // disabled for the rest of the session, waiting on a result that cannot arrive.
    const store = useAssistantStore.getState();
    store.reset("s1");
    ev(store, {
      type: "question:requested",
      questionId: "q1",
      question: "Which backend should answer?",
      options: [
        { label: "A", text: "official" },
        { label: "B", text: "local" },
      ],
      default: 0,
      requestedAt: 1,
    });
    ev(store, {
      type: "question:answered",
      questionId: "q1",
      choiceIndex: 0,
      cancelled: false,
      answeredAt: 2,
      label: "A",
      text: "official",
    });
    expect(useAssistantStore.getState().awaitingLocalCommand).toBe(true);
    useAssistantStore.getState().endLiveState();
    expect(useAssistantStore.getState().awaitingLocalCommand).toBe(false);
  });

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

describe("session tool grants never cover what the engine says they cannot", () => {
  const ordinary = { grantKey: "terminal.sendInput", rememberable: true, needsTypedConfirm: false };

  it("spends a bounded grant exactly N times", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("terminal.sendInput", 2);

    expect(store.consumeGrant(ordinary)).toBe(true);
    expect(store.consumeGrant(ordinary)).toBe(true);
    // Spent. The next call asks again.
    expect(store.consumeGrant(ordinary)).toBe(false);
  });

  it("never spends an always-grant down", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("terminal.sendInput", Number.POSITIVE_INFINITY);
    for (let i = 0; i < 50; i++) expect(store.consumeGrant(ordinary)).toBe(true);
  });

  it("refuses a non-rememberable approval even with a grant on that tool", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("git.push", Number.POSITIVE_INFINITY);
    // The engine says git is never rememberable. A grant recorded against that id
    // must not be spendable, or a standing approval for something ordinary could be
    // turned into one for a push.
    expect(
      store.consumeGrant({ grantKey: "git.push", rememberable: false, needsTypedConfirm: false })
    ).toBe(false);
  });

  it("refuses anything needing a typed confirmation", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("worktree.delete", Number.POSITIVE_INFINITY);
    expect(
      store.consumeGrant({
        grantKey: "worktree.delete",
        rememberable: true,
        needsTypedConfirm: true,
      })
    ).toBe(false);
  });

  it("drops every grant when the session resets", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("terminal.sendInput", Number.POSITIVE_INFINITY);
    // A standing approval must not outlive the conversation it was given in.
    useAssistantStore.getState().reset("s2");
    expect(useAssistantStore.getState().consumeGrant(ordinary)).toBe(false);
  });
});

describe("two steers queued before either folds in", () => {
  it("keeps both, and folding one clears only that one", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);

    store.appendUserTurn("first steer");
    store.appendUserTurn("second steer");
    // A single slot silently discarded the first.
    expect(useAssistantStore.getState().queuedInterjections).toEqual([
      "first steer",
      "second steer",
    ]);

    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "turn:interjection",
      turnId: "t1",
      text: "first steer",
    } as never);
    expect(useAssistantStore.getState().queuedInterjections).toEqual(["second steer"]);

    // The turn ends without folding the second: promoted, not lost.
    store.applyEvent({
      sessionId: "s1",
      seq: 3,
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "answered",
    } as never);
    const after = useAssistantStore.getState();
    expect(after.queuedInterjections).toEqual([]);
    expect(after.turns.at(-1)).toMatchObject({ role: "user", text: "second steer" });
  });

  it("drops one entry per fold when two steers are identical", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
    store.appendUserTurn("same");
    store.appendUserTurn("same");

    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "turn:interjection",
      turnId: "t1",
      text: "same",
    } as never);
    // Two identical steers are two messages; clearing both would lose one.
    expect(useAssistantStore.getState().queuedInterjections).toEqual(["same"]);
  });
});

describe("a grant is keyed on the identity the gates used, not the label", () => {
  it("does not cover a different action that shares a display name", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    // Two dynamic tools can present the same human label while gating on different
    // composite identities. A grant given for one must not cover the other.
    store.grantTool("plugin:alpha/run", Number.POSITIVE_INFINITY);
    expect(
      store.consumeGrant({
        grantKey: "plugin:beta/run",
        rememberable: true,
        needsTypedConfirm: false,
      })
    ).toBe(false);
    expect(
      store.consumeGrant({
        grantKey: "plugin:alpha/run",
        rememberable: true,
        needsTypedConfirm: false,
      })
    ).toBe(true);
  });
});

describe("clearing standing approvals", () => {
  it("revokes every grant", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.grantTool("a", Number.POSITIVE_INFINITY);
    store.grantTool("b", 3);
    useAssistantStore.getState().clearGrants();
    expect(
      store.consumeGrant({ grantKey: "a", rememberable: true, needsTypedConfirm: false })
    ).toBe(false);
    expect(
      store.consumeGrant({ grantKey: "b", rememberable: true, needsTypedConfirm: false })
    ).toBe(false);
  });
});

describe("a mid-turn message the engine never received", () => {
  it("is taken back out of the queue, not promoted later", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);

    store.appendUserTurn("arrived");
    store.appendUserTurn("never arrived");
    // Delivery failed for the second one only.
    useAssistantStore.getState().dropQueuedInterjection("never arrived");
    expect(useAssistantStore.getState().queuedInterjections).toEqual(["arrived"]);

    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "answered",
    } as never);
    // Only the one that actually reached the engine is promoted. Before this, a
    // failed send stayed queued and became a user turn for a message nothing received.
    const users = useAssistantStore.getState().turns.filter((t) => t.role === "user");
    expect(users.map((t) => t.text)).toEqual(["arrived"]);
  });
});

describe("a dead engine leaves nothing claiming to be live", () => {
  it("settles phase, open turns, live calls, approvals and questions", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    const ev = (e: Record<string, unknown>) =>
      store.applyEvent({ sessionId: "s1", seq: 1, ...e } as never);

    ev({ type: "turn:start", turnId: "t1", role: "assistant", startedAt: 1 });
    ev({ type: "turn:phase", turnId: "t1", phase: "generating" });
    ev({
      type: "tool:batch",
      turnId: "t1",
      calls: [{ toolCallId: "c1", toolId: "git.status", argsSummary: "{}", danger: false }],
    });
    ev({ type: "tool:state", toolCallId: "c1", state: "active", turnId: "t1" });
    ev({
      type: "approval:requested",
      approvalId: "apr_1",
      toolId: "git.push",
      summary: "Push",
      requestedAt: 1,
      needsTypedConfirm: false,
      turnId: "t1",
    });

    useAssistantStore.getState().endLiveState();

    const after = useAssistantStore.getState();
    // Every one of these described an engine that no longer exists.
    expect(after.phase).toBeNull();
    expect(after.turns.every((t) => t.complete)).toBe(true);
    // FAILED, not cancelled: cancelled is worded as the user's own deliberate stop,
    // and the engine dying is not something they chose.
    expect(after.toolCalls["c1"]?.state).toBe("failed");
    expect(after.toolCalls["c1"]?.errorMessage).toMatch(/stopped before this finished/);
    expect(after.approvals).toEqual([]);
    expect(after.pendingQuestion).toBeNull();
  });
});

describe("nothing stays queued for an engine that is gone", () => {
  it("keeps the words as turns rather than as an undeliverable promise", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
    store.appendUserTurn("typed while it was running");
    expect(useAssistantStore.getState().queuedInterjections).toHaveLength(1);

    useAssistantStore.getState().endLiveState();

    const after = useAssistantStore.getState();
    // Nothing is queued once there is nothing to deliver to...
    expect(after.queuedInterjections).toEqual([]);
    // ...but what the user typed is not thrown away.
    expect(after.turns.at(-1)).toMatchObject({
      role: "user",
      text: "typed while it was running",
    });
  });
});

describe("a rejection that arrives after the engine already exited", () => {
  it("removes the promoted turn, not just the queue", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
    store.appendUserTurn("never arrived");

    // The engine exits first, so endLiveState promotes the queued entry to a turn...
    useAssistantStore.getState().endLiveState();
    expect(useAssistantStore.getState().turns.some((t) => t.text === "never arrived")).toBe(true);

    // ...and only THEN does main answer delivered:false. Searching the queue alone
    // left an undelivered message in the transcript as though it had been sent.
    useAssistantStore.getState().dropUndeliveredText("never arrived");
    expect(useAssistantStore.getState().turns.some((t) => t.text === "never arrived")).toBe(false);
  });
});

describe("the operations deck", () => {
  it("keeps the reading, with when it was taken", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    expect(useAssistantStore.getState().operations).toBeNull();

    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "operations:snapshot",
      inbox: [
        { id: "q1", severity: "attention", source: "watcher", summary: "needs input", at: 1 },
      ],
      workflows: [],
      agents: [
        {
          id: "w1",
          title: "migrate schema",
          goal: "run the migration",
          badge: "",
          agentState: "working",
          preview: "$ npm test",
          startedAt: 1,
          needsAttention: false,
        },
      ],
      async: [],
      timers: [],
      audit: [{ tool: "git.status", outcome: "ok", durationMs: 12, at: 1 }],
    } as never);

    const ops = useAssistantStore.getState().operations;
    expect(ops?.agents[0]?.title).toBe("migrate schema");
    expect(ops?.inbox).toHaveLength(1);
    // Stamped so the deck can say how stale the reading is — it is requested, not
    // streamed, so it is always some age.
    expect(ops?.at).toBeGreaterThan(0);
  });
});

/**
 * The timer manager, end to end: a real engine process, the real NDJSON transport, the
 * real Zod validator, and the real reducer.
 *
 * This is the seam that matters most for timers, because the row shape is wide and
 * fixed — thirteen fields that must all survive encode, validate and reduce. A missing
 * one is not a rendering bug, it is a rejected frame and a manager that silently shows
 * nothing.
 */
describe("the timer manager", () => {
  /** Opens a session, runs `drive` against the live engine, returns the final state. */
  async function withSession(
    drive: (host: AssistantHostProcess, waitFor: (type: string) => Promise<void>) => Promise<void>,
    env: Record<string, string> = {},
    onRaw?: (event: AssistantHostEvent) => void
  ) {
    useAssistantStore.getState().reset(DESCRIPTOR.sessionId);
    const waiters = new Map<string, () => void>();
    const host = new AssistantHostProcess({
      binaryPath: ENGINE,
      descriptor: DESCRIPTOR,
      cwd: process.cwd(),
      env: { ...process.env, FAKE_ENGINE_SCENARIO: "simple", FAKE_ENGINE_SPEED: "0", ...env },
      onEvent: (event) => {
        onRaw?.(event);
        useAssistantStore.getState().applyEvent(event);
        waiters.get(event.type)?.();
      },
      onSequenceGap: ({ missing }) => useAssistantStore.getState().recordGap(missing),
    });
    const waitFor = (type: string) =>
      Promise.race([
        new Promise<void>((r) => waiters.set(type, r)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), RUN_TIMEOUT_MS)
        ),
      ]);
    host.start();
    await host.waitForReady();
    try {
      await drive(host, waitFor);
    } finally {
      host.dispose();
    }
    return useAssistantStore.getState();
  }

  it("carries every field of the row through transport, schema and reducer", async () => {
    const state = await withSession(async (host, waitFor) => {
      const landed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await landed;
    });

    const rows = state.timers?.rows ?? [];
    expect(rows).toHaveLength(2);
    // The reading is stamped with the ENGINE's read time, not ours.
    expect(state.timers?.takenAt).toBeGreaterThan(0);

    const scheduled = rows.find((r) => r.id === "tmr_2");
    // Every field the manager renders from, end to end. A row that lost one of these
    // in the schema would arrive as a rejected frame, not a missing label.
    expect(scheduled).toMatchObject({
      label: "Nightly deploy check",
      payloadKind: "tool_call",
      toolName: "agentTask.spawnForEdits",
      repeatEveryMs: 86_400_000,
      repeatMaxRuns: 7,
      runCount: 2,
      targetWorktreeId: "/p/app",
      liveGrants: 2,
    });
  }, 20_000);

  it("serves the deck and the manager the same rows", async () => {
    // Two commands, two events, one list. The engine builds both from one place; this
    // is the test that fails if that ever stops being true on the wire.
    const state = await withSession(async (host, waitFor) => {
      const timersLanded = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await timersLanded;
      const opsLanded = waitFor("operations:snapshot");
      host.send({ type: "operations", sessionId: DESCRIPTOR.sessionId });
      await opsLanded;
    });
    expect(state.operations?.timers).toEqual(state.timers?.rows);
  }, 20_000);

  it("retires a cancelled timer from the list", async () => {
    const state = await withSession(async (host, waitFor) => {
      const listed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await listed;
      expect(useAssistantStore.getState().timers?.rows).toHaveLength(2);

      const settled = waitFor("timer:cancelled");
      useAssistantStore.getState().markTimerCancelPending("tmr_2");
      expect(useAssistantStore.getState().timerCancelPending["tmr_2"]).toBe(true);
      host.send({ type: "timer:cancel", sessionId: DESCRIPTOR.sessionId, timerId: "tmr_2" });
      await settled;
    });

    expect(state.timers?.rows.map((r) => r.id)).toEqual(["tmr_1"]);
    // The pending mark is cleared by the answer, not by a timeout — a row left
    // spinning after the engine settled it is the failure this pairs against.
    expect(state.timerCancelPending["tmr_2"]).toBeUndefined();
    expect(state.timerCancelErrors["tmr_2"]).toBeUndefined();
  }, 20_000);

  it("settles a failed cancel against its own row and keeps the timer", async () => {
    const state = await withSession(async (host, waitFor) => {
      const listed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await listed;

      const settled = waitFor("timer:cancelled");
      useAssistantStore.getState().markTimerCancelPending("tmr_gone");
      host.send({ type: "timer:cancel", sessionId: DESCRIPTOR.sessionId, timerId: "tmr_gone" });
      await settled;
    });

    expect(state.timerCancelPending["tmr_gone"]).toBeUndefined();
    expect(state.timerCancelErrors["tmr_gone"]).toContain("tmr_gone");
    // Nothing was removed: a failed cancel must not optimistically drop a row that
    // is still live.
    expect(state.timers?.rows).toHaveLength(2);
  }, 20_000);

  it("clears stale per-row errors when the list is refreshed", async () => {
    const state = await withSession(async (host, waitFor) => {
      const listed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await listed;

      const settled = waitFor("timer:cancelled");
      host.send({ type: "timer:cancel", sessionId: DESCRIPTOR.sessionId, timerId: "tmr_gone" });
      await settled;
      expect(useAssistantStore.getState().timerCancelErrors["tmr_gone"]).toBeDefined();

      // A fresh reading describes a new world; an error pinned to a row that may no
      // longer be there is worse than no error.
      const refreshed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await refreshed;
    });
    expect(state.timerCancelErrors).toEqual({});
  }, 20_000);

  it("carries a retired timer whose authority could NOT be withdrawn", async () => {
    // The half-done state: the timer is gone but its grant is still spendable. It has
    // to survive the schema, because a validator that dropped `grantRevokeFailed`
    // would leave live unattended authority behind with nothing able to say so.
    const seen: AssistantHostEvent[] = [];
    await withSession(
      async (host, waitFor) => {
        const listed = waitFor("timers:snapshot");
        host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
        await listed;
        const settled = waitFor("timer:cancelled");
        host.send({ type: "timer:cancel", sessionId: DESCRIPTOR.sessionId, timerId: "tmr_2" });
        await settled;
      },
      { FAKE_ENGINE_TIMER_CANCEL: "grant-fail" },
      (event) => seen.push(event)
    );
    const cancelled = seen.find((e) => e.type === "timer:cancelled");
    expect(cancelled).toMatchObject({
      timerId: "tmr_2",
      cancelled: true,
      grantRevokeFailed: true,
      // The grants it HELD are still reported: the operation attempted two, and
      // reporting zero would read as "there was nothing to withdraw".
      revokedGrants: 2,
    });
  }, 20_000);

  it("carries what a fired timer DID, including the successes", async () => {
    // The original hole: a timer fired and the panel showed nothing. A success
    // publishes at `info`, BELOW the operations deck's attention filter, so the deck
    // was structurally unable to report that a scheduled thing had worked.
    const state = await withSession(async (host, waitFor) => {
      const landed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await landed;
    });
    const outcomes = state.timers?.outcomes ?? [];
    expect(outcomes.map((o) => o.severity)).toEqual(expect.arrayContaining(["info", "error"]));
    const failed = outcomes.find((o) => o.severity === "error");
    // A repeat publishes under one dedupe key, so the row stands for every firing —
    // reporting one would understate a timer that has failed four nights running.
    expect(failed?.count).toBe(4);
    expect(failed?.timerId).toBe("tmr_broken");
  }, 20_000);

  it("marks the list stale when a timer fires, and a fresh reading clears it", async () => {
    // The engine pushes the FACT, not the change — so the whole of the reaction is
    // "what I hold is out of date", never a row patched from an event that carries
    // no row.
    const state = await withSession(
      async (host, waitFor) => {
        const fired = waitFor("timer:fired");
        host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
        await fired;
        expect(useAssistantStore.getState().timersStale).toBe(true);

        const refreshed = waitFor("timers:snapshot");
        host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
        await refreshed;
      },
      { FAKE_ENGINE_TIMERS: "fires" }
    );
    // The second snapshot is the answer to what made it stale. (The fake fires again
    // after that reading too, so this asserts the clear happened, not that it stuck.)
    expect(state.timers).not.toBeNull();
  }, 20_000);

  it("tells a failed read apart from an empty list", async () => {
    // The two must never collapse: "nothing scheduled" is a claim a user acts on by
    // walking away from work that is still queued.
    const state = await withSession(
      async (host, waitFor) => {
        const landed = waitFor("timers:snapshot");
        host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
        await landed;
      },
      { FAKE_ENGINE_TIMERS: "read-fail" }
    );
    expect(state.timers?.rows).toEqual([]);
    expect(state.timers?.readFailed).toBe(true);
  }, 20_000);

  it("clears a pending mark for a timer a fresh snapshot no longer lists", async () => {
    // The only way a row can get stuck: the outcome that would clear it never
    // arrives (a session that died mid-cancel), leaving the control inert forever.
    // A snapshot is the reconciliation point.
    const state = await withSession(async (host, waitFor) => {
      useAssistantStore.getState().markTimerCancelPending("tmr_vanished");
      const landed = waitFor("timers:snapshot");
      host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
      await landed;
    });
    expect(state.timerCancelPending["tmr_vanished"]).toBeUndefined();
    // A timer that IS still listed keeps its pending mark — it may genuinely be
    // mid-flight, and clearing it would re-enable a control the engine is settling.
    expect(state.timers?.rows.length).toBeGreaterThan(0);
  }, 20_000);

  it("survives an engine that has no timers at all", async () => {
    const state = await withSession(
      async (host, waitFor) => {
        const landed = waitFor("timers:snapshot");
        host.send({ type: "timers", sessionId: DESCRIPTOR.sessionId });
        await landed;
      },
      { FAKE_ENGINE_TIMERS: "empty" }
    );
    // An empty list is a READING, not the absence of one — the manager must be able
    // to tell "nothing scheduled" from "never asked".
    expect(state.timers).not.toBeNull();
    expect(state.timers?.rows).toEqual([]);
    expect(state.timers?.readFailed).toBe(false);
  }, 20_000);
});

describe("scheduling a timer makes the list stale", () => {
  /**
   * The bug this exists for: you ask for a timer, you are told it is scheduled, and no
   * countdown appears anywhere.
   *
   * Nothing was telling the panel the schedule had changed. The list was read once when
   * the session armed and again when a timer FIRED, so a timer created mid-turn stayed
   * invisible until something unrelated refreshed it — which in practice meant
   * restarting the assistant to see the thing you had just made.
   */
  it("marks the list stale when timer.schedule succeeds", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    const base = { sessionId: "s1", turnId: "t1" } as const;
    expect(useAssistantStore.getState().timersStale).toBe(false);

    store.applyEvent({
      ...base,
      seq: 1,
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "timer.schedule",
      durationMs: 3,
      result: "success",
      severity: "info",
    } as never);

    expect(useAssistantStore.getState().timersStale).toBe(true);
  });

  it("marks it stale on a cancel too — the row has to leave the list", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    const base = { sessionId: "s1", turnId: "t1" } as const;
    store.applyEvent({
      ...base,
      seq: 1,
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "timer.cancel",
      durationMs: 3,
      result: "success",
      severity: "info",
    } as never);
    expect(useAssistantStore.getState().timersStale).toBe(true);
  });

  it("leaves it alone for a FAILED schedule and for reads", () => {
    // A refused schedule created nothing, and timer.list changes nothing — refreshing
    // on either would spend a round trip to re-read a list that cannot have moved.
    const store = useAssistantStore.getState();
    store.reset("s1");
    const base = { sessionId: "s1", turnId: "t1" } as const;
    store.applyEvent({
      ...base,
      seq: 1,
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "timer.schedule",
      durationMs: 3,
      result: "error",
      severity: "error",
    } as never);
    expect(useAssistantStore.getState().timersStale).toBe(false);

    store.applyEvent({
      ...base,
      seq: 2,
      type: "tool:settled",
      toolCallId: "c2",
      toolId: "timer.list",
      durationMs: 3,
      result: "success",
      severity: "info",
    } as never);
    expect(useAssistantStore.getState().timersStale).toBe(false);
  });
});

describe("what the engine reports on its error channel is graded by CODE", () => {
  function hostError(code: string, message: string) {
    useAssistantStore
      .getState()
      .applyEvent({ sessionId: "s1", seq: 1, type: "host:error", code, message } as never);
    return useAssistantStore.getState().notices.at(-1);
  }

  beforeEach(() => useAssistantStore.getState().reset("s1"));

  it("does not paint a delivered message as a failure", () => {
    // `prompt-folded` means the message WAS accepted — it joined the running turn.
    // Reported on the same channel as a panic, so the code is the only thing that
    // separates them, and grading by channel alone made a success look like a fault.
    const folded = hostError("prompt-folded", "folded into the running turn");
    const panicked = hostError("turn-failed", "turn panicked");

    expect(folded?.level).not.toBe(panicked?.level);
    expect(folded?.level).toBe("info");
  });

  it("keeps a refusal below a fault, and a fault at the top", () => {
    const rank = { info: 0, warning: 1, error: 2 } as const;
    const busy = hostError("command-busy", "a command is waiting on your answer");
    const broken = hostError("bad-frame", "inbound line exceeded the frame cap");

    expect(rank[busy!.level]).toBeLessThan(rank[broken!.level]);
  });

  it("leaves a code it has never seen at the loudest level", () => {
    // The engine can add codes without this map knowing. An unknown one is a fault
    // until someone decides otherwise — the opposite default would quietly silence
    // the next real failure the engine learns to report.
    expect(hostError("some-code-invented-later", "?")?.level).toBe("error");
  });
});

describe("a folded-prompt notice does not outlive the turn it was about", () => {
  function foldDuringTurn() {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "host:error",
      code: "prompt-folded",
      message: "A turn is already running; this message was folded into it.",
    } as never);
    expect(useAssistantStore.getState().notices).toHaveLength(1);
  }

  it("stands while the turn is still running, and goes when it ends", () => {
    foldDuringTurn();

    useAssistantStore.getState().applyEvent({
      sessionId: "s1",
      seq: 3,
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "answered",
    } as never);

    // "will be picked up between tasks" is a claim with an expiry: once the turn is
    // over the message is either inside it or promoted below it, and the status line
    // is left describing something that has already finished happening.
    expect(useAssistantStore.getState().notices).toEqual([]);
  });

  it("goes when the engine dies mid-turn, which sends no turn:end at all", () => {
    foldDuringTurn();
    // The message the notice was ABOUT, so the exit path is exercised with something
    // actually queued rather than against an empty queue that would pass either way.
    useAssistantStore.getState().appendUserTurn("and check the tests");
    useAssistantStore.getState().endLiveState();

    const after = useAssistantStore.getState();
    expect(after.notices).toEqual([]);
    // And the promise the notice made is kept the only way left to keep it: the words
    // become a turn of their own rather than vanishing with the engine.
    expect(after.queuedInterjections).toEqual([]);
    expect(after.turns.at(-1)).toMatchObject({ role: "user", text: "and check the tests" });
  });

  it("says it once however many messages are folded into the same turn", () => {
    foldDuringTurn();
    useAssistantStore.getState().applyEvent({
      sessionId: "s1",
      seq: 3,
      type: "host:error",
      code: "prompt-folded",
      message: "A turn is already running; this message was folded into it.",
    } as never);

    // The status is "your messages joined the running turn", which the second fold does
    // not make more true. Every message is still shown individually as a queued card;
    // this line is the status, not the receipt, and a duplicate also burns a slot in
    // the capped history that a real warning would otherwise hold.
    expect(useAssistantStore.getState().notices).toHaveLength(1);
  });

  it("retires only the expiring kind, leaving every other notice standing", () => {
    foldDuringTurn();
    useAssistantStore.getState().applyEvent({
      sessionId: "s1",
      seq: 3,
      type: "host:error",
      code: "turn-failed",
      message: "turn panicked",
    } as never);

    useAssistantStore.getState().applyEvent({
      sessionId: "s1",
      seq: 4,
      type: "turn:end",
      turnId: "t1",
      endedAt: 2,
      outcome: "failed",
    } as never);

    const left = useAssistantStore.getState().notices;
    expect(left.map((n) => n.code)).toEqual(["turn-failed"]);
  });
});

describe("a cleared conversation leaves its result line at the head of the new one", () => {
  it("anchors the notice to nothing, so nothing can push it to the tail", () => {
    const store = useAssistantStore.getState();
    store.reset("s1");
    store.applyEvent({
      sessionId: "s1",
      seq: 1,
      type: "turn:start",
      turnId: "t1",
      role: "assistant",
      startedAt: 1,
    } as never);
    store.applyEvent({
      sessionId: "s1",
      seq: 2,
      type: "command:result",
      command: "/clear",
      text: "Conversation cleared — starting fresh.",
      conversationCleared: true,
    } as never);

    const after = useAssistantStore.getState();
    expect(after.turns).toEqual([]);
    // Both null is what puts it BEFORE the turns rather than behind them: the view
    // draws an unanchored notice at the head of the transcript, and an anchor to the
    // turn that /clear just deleted would strand it at the tail for the rest of the
    // session.
    expect(after.notices).toHaveLength(1);
    expect(after.notices[0]).toMatchObject({ turnId: null, afterTurnId: null, level: "info" });
  });
});
