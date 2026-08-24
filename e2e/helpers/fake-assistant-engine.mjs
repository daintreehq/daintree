#!/usr/bin/env node
/**
 * A scriptable stand-in for the Daintree Assistant engine.
 *
 * Speaks the SAME protocol as the real Go binary — `host --stdio`, NDJSON, protocol
 * v3 — but emits a scripted sequence instead of talking to a model. Point
 * `DAINTREE_ASSISTANT_BIN` at this file and Daintree cannot tell the difference.
 *
 * ## Why this exists
 *
 * Driving the real engine in a test means a live backend, real model latency, real
 * spend, and non-deterministic prose. None of that tests the PANEL — it tests the
 * model. What the panel needs proving about it is exact and boring: that a tool batch
 * renders as a plan, that `waiting` reads as blocked-on-you, that a typed
 * confirmation cannot be clicked past, that `turn:end` content replaces the streamed
 * buffer, that a sequence gap is surfaced rather than swallowed. Every one of those
 * is a specific byte sequence on the wire, so the right way to test them is to send
 * exactly those bytes.
 *
 * It also covers cases the real engine will not produce on demand: a dropped frame, a
 * rate-limit, a protocol-version mismatch, a mid-turn crash.
 *
 * ## Fidelity
 *
 * This is only useful while it stays a faithful stand-in. Two things keep it honest:
 *
 *  - `SCENARIOS` below emits the same event SHAPES the Go encoders produce, and the
 *    E2E suite validates its output against Daintree's own Zod schema — the same
 *    validator the main process uses — so a divergence fails a test rather than
 *    quietly testing a fiction.
 *  - Sequence numbers are stamped centrally here, exactly as the engine stamps them
 *    under one lock, so `seq` semantics are real rather than decorative.
 *
 * ## Usage
 *
 *   DAINTREE_ASSISTANT_BIN=/path/to/fake-assistant-engine.mjs
 *   FAKE_ENGINE_SCENARIO=streaming            # which script to run on a prompt
 *   FAKE_ENGINE_SPEED=1                       # delay multiplier; 0 = instant
 *
 * Daintree invokes it as `<bin> host --stdio`; the argv is accepted and ignored.
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 3;
const SCENARIO = process.env.FAKE_ENGINE_SCENARIO ?? "streaming";
const SPEED = Number(process.env.FAKE_ENGINE_SPEED ?? "1");

let seq = 0;
let sessionId = "";
let turnCounter = 0;
/** Approvals this process is parked on: approvalId → resolver. */
const pending = new Map();
const pendingQuestions = new Map();
/** Counts operations requests, so each reading is DISTINGUISHABLE from the last. */
let operationsReads = 0;
/** Announced-but-unsettled calls, so an interrupt can terminalize them like the engine. */
const liveTools = new Map();

/** Parks until the host answers, mirroring the engine's blocking AskChoice hook. */
function awaitQuestion(questionId) {
  return new Promise((resolve) => pendingQuestions.set(questionId, resolve));
}
let interrupted = false;

/** Writes one NDJSON frame, stamping the next sequence number. */
function emit(event) {
  // Mirror the engine's own tracking of announced-but-unsettled calls, so an interrupt
  // here terminalizes exactly what one would terminalize there.
  if (event.type === "tool:batch") {
    for (const c of event.calls ?? []) liveTools.set(c.toolCallId, "queued");
  } else if (event.type === "tool:state") {
    if (event.state === "done" || event.state === "failed") liveTools.delete(event.toolCallId);
    else liveTools.set(event.toolCallId, event.state);
  } else if (event.type === "tool:settled") {
    liveTools.delete(event.toolCallId);
  }
  seq += 1;
  process.stdout.write(`${JSON.stringify({ ...event, sessionId, seq })}\n`);
}

/**
 * Deliberately consumes a sequence number WITHOUT emitting it, simulating a frame
 * lost to backpressure. This is the only way to exercise Daintree's gap detection —
 * the real engine drops a frame so rarely that waiting for one is not a test.
 */
function dropFrame() {
  seq += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

/**
 * A pause a TEST needs to observe, as opposed to one that only makes a stream look
 * believable. Deliberately NOT scaled by `FAKE_ENGINE_SPEED`: the suite runs at speed 0
 * so nothing waits on animation, and a hold that collapsed along with it would close
 * the very window an assertion is about.
 */
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams a string as token frames, in believable chunks rather than per character.
 *
 * `paced: true` makes the gaps real ones — `hold` rather than `sleep` — for a scenario
 * whose point is that a test can OBSERVE the stream in flight. At the suite's speed 0
 * every scaled gap collapses, so the whole answer lands between two Playwright polls
 * and a state that exists only while text is arriving is never seen.
 */
async function streamText(turnId, text, { chunk = 12, delay = 18, paced = false } = {}) {
  for (let i = 0; i < text.length; i += chunk) {
    if (interrupted) return;
    emit({ type: "turn:token", turnId, chunk: text.slice(i, i + chunk) });
    await (paced ? hold(delay) : sleep(delay));
  }
}

/** Waits for the host to answer an approval. Resolves with the decision. */
function awaitApproval(approvalId) {
  return new Promise((resolve) => pending.set(approvalId, resolve));
}

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Scenarios. Each is one full turn, driven by a prompt.
// ---------------------------------------------------------------------------

const SCENARIOS = {
  /** Prose only. The simplest possible turn — proves streaming and completion. */
  async simple(turnId) {
    emit({ type: "turn:phase", turnId, phase: "analyzing" });
    await sleep(60);
    emit({ type: "turn:phase", turnId, phase: "generating" });
    const answer = "Three worktrees are ready to review.";
    await streamText(turnId, answer);
    emit({
      type: "usage",
      turnId,
      promptTokens: 1200,
      completionTokens: 40,
      totalTokens: 1240,
      contextTokens: 12_400,
      contextThreshold: 120_000,
      contextWindow: 200_000,
    });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /** A tool batch that runs to completion under streaming prose. */
  async streaming(turnId) {
    emit({ type: "turn:phase", turnId, phase: "analyzing" });
    await sleep(50);
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        // Verb/target as the real engine computes them (internal/host/presentation.go).
        // Omitting them made every CI run assert the raw-id fallback — the branch that
        // fires only for a tool the engine does NOT know — while the branch every real
        // call takes went untested.
        {
          toolCallId: "c1",
          toolId: "worktree.list",
          argsSummary: '{"status":"ready"}',
          danger: false,
          verb: "Listed worktrees",
        },
        {
          toolCallId: "c2",
          toolId: "git.getProjectPulse",
          argsSummary: "{}",
          danger: false,
          verb: "Read git state",
          target: "wt_forge",
        },
      ],
    });
    emit({ type: "turn:phase", turnId, phase: "tool_running" });

    for (const [id, tool] of [
      ["c1", "worktree.list"],
      ["c2", "git.getProjectPulse"],
    ]) {
      emit({ type: "tool:state", toolCallId: id, state: "active", turnId });
      emit({
        type: "tool:started",
        toolCallId: id,
        toolId: tool,
        argsSummary: "{}",
        startedAt: now(),
        turnId,
        danger: false,
      });
      emit({ type: "tool:progress", toolCallId: id, message: "reading", turnId });
      await sleep(80);
      emit({
        type: "tool:settled",
        toolCallId: id,
        toolId: tool,
        durationMs: 240,
        result: "success",
        severity: "info",
        turnId,
      });
      emit({ type: "tool:state", toolCallId: id, state: "done", turnId });
    }

    emit({ type: "turn:phase", turnId, phase: "generating" });
    const answer = "Three worktrees are ready:\n\n- `wt_forge`\n- `wt_switcher`\n- `wt_theme`";
    await streamText(turnId, answer);
    emit({
      type: "usage",
      turnId,
      promptTokens: 18_400,
      completionTokens: 820,
      totalTokens: 19_220,
      cachedTokens: 12_100,
      cacheHitRatio: 0.657,
      contextTokens: 31_200,
      contextThreshold: 120_000,
      contextWindow: 200_000,
    });
    emit({ type: "cost", turnId, total: 0.0412, complete: true });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /**
   * A typed confirmation. The turn genuinely BLOCKS here: nothing else is emitted
   * until the host answers, which is what makes this a real test of the approval
   * flow rather than a screenshot of a card.
   */
  async approval(turnId) {
    emit({ type: "turn:phase", turnId, phase: "tool_running" });
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        {
          toolCallId: "c1",
          toolId: "git.push",
          argsSummary: '{"remote":"origin","force":true}',
          danger: true,
        },
      ],
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "waiting", turnId });
    emit({ type: "turn:phase", turnId, phase: "awaiting_approval" });
    emit({
      type: "approval:requested",
      approvalId: "apr_1",
      toolId: "git.push",
      summary: "Push 3 commits to origin/feature/forge-counts",
      consequence: "Rewrites the remote branch. Anyone who pulled it will need to reset.",
      argsSummary: '{"remote":"origin","branch":"feature/forge-counts","force":true}',
      riskClass: "git",
      needsTypedConfirm: true,
      requestedAt: now(),
      turnId,
    });

    const decision = await awaitApproval("apr_1");
    emit({ type: "approval:decided", approvalId: "apr_1", decision, decidedAt: now() });

    if (decision === "approved") {
      emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
      await sleep(60);
      emit({
        type: "tool:settled",
        toolCallId: "c1",
        toolId: "git.push",
        durationMs: 900,
        result: "success",
        severity: "info",
        turnId,
      });
      emit({ type: "tool:state", toolCallId: "c1", state: "done", turnId });
      const answer = "Pushed. The branch is up to date with origin.";
      emit({ type: "turn:phase", turnId, phase: "generating" });
      await streamText(turnId, answer);
      emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
    } else {
      emit({
        type: "tool:settled",
        toolCallId: "c1",
        toolId: "git.push",
        durationMs: 5,
        result: "error",
        errorMessage: "You declined the push, so nothing was sent to origin.",
        severity: "warning",
        errorCode: "USER_DECLINED",
        turnId,
      });
      emit({ type: "tool:state", toolCallId: "c1", state: "failed", turnId });
      const answer = "Left it alone. Nothing was pushed.";
      await streamText(turnId, answer);
      emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
    }
  },

  /** A non-typed approval — a single click is enough. */
  async approvalSimple(turnId) {
    emit({
      type: "approval:requested",
      approvalId: "apr_2",
      toolId: "terminal.sendCommand",
      toolKey: "terminal.sendCommand",
      summary: "Run `npm test` in wt_forge",
      argsSummary: '{"command":"npm test"}',
      riskClass: "terminal",
      needsTypedConfirm: false,
      // The real engine marks a terminal-risk dispatch rememberable and always supplies
      // the effective key (internal/host/bridge.go). Without it the card renders no
      // grant buttons, so "Allow 5×" and "Always allow" — the two controls that widen
      // authority beyond a single call — were unreachable from every test.
      rememberable: true,
      requestedAt: now(),
      turnId,
    });
    const decision = await awaitApproval("apr_2");
    emit({ type: "approval:decided", approvalId: "apr_2", decision, decidedAt: now() });
    const answer = decision === "approved" ? "Tests are running." : "Skipped.";
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /**
   * The self-healing case: tokens stream a WRONG, truncated body, then `turn:end`
   * carries the authoritative text. A correct consumer shows the authoritative
   * version. A consumer that trusts the token stream shows the broken one — which is
   * exactly the bug protocol v3 exists to make impossible.
   */
  /**
   * Multi-block prose: paragraphs, a heading, a list, a fenced block.
   *
   * Exists because "the answer arrived" and "the answer is READABLE" are separate
   * claims, and only the first was ever asserted. A CSS specificity slip once zeroed
   * the gap between every paragraph — `.assistant-prose p { margin: 0 }` at (0,1,1)
   * beating the sibling rule at (0,1,0) — and the whole answer rendered as one slab
   * with nothing failing anywhere.
   */
  async paragraphs(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    const answer = [
      "First paragraph, which is separated from the next by a blank line.",
      "Second paragraph, which must sit visibly apart from the first.",
      "## A heading",
      "- one\n- two",
      "```sh\nnpm run build\n```",
      "Third paragraph after the list.",
    ].join("\n\n");
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  async authoritativeContent(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    await streamText(turnId, "PARTIAL-STREAM-SHOULD-BE-REPLACED");
    const answer = "The authoritative answer replaced the streamed text.";
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /**
   * Drops a frame mid-stream. The host must notice the sequence gap and say the
   * transcript is incomplete rather than presenting it as whole.
   */
  async droppedFrame(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    emit({ type: "turn:token", turnId, chunk: "This answer " });
    dropFrame(); // the lost frame
    emit({ type: "turn:token", turnId, chunk: "has a hole in it." });
    const answer = "This answer has a hole in it.";
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /** Standing degraded conditions: throttled, and a failing tool. */
  async degraded(turnId) {
    emit({
      type: "notice",
      level: "warning",
      message: "MCP connection degraded — orchestration tools are offline.",
      turnId,
    });
    emit({ type: "model:rate-limited", turnId });
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        { toolCallId: "c1", toolId: "queue.digest", argsSummary: '{"since":"12h"}', danger: false },
      ],
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
    await sleep(60);
    emit({
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "queue.digest",
      durationMs: 4200,
      result: "error",
      severity: "error",
      errorCode: "MCP_UNREACHABLE",
      errorMessage: "The Daintree control plane is not connected, so no agent could be spawned.",
      turnId,
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "failed", turnId });
    emit({ type: "cost", turnId, total: 1.284, complete: false });
    const answer = "I couldn't reach the orchestration tools, so this is from memory only.";
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "hedged", content: answer });
  },

  /**
   * The model asks the user a multiple-choice question and the turn BLOCKS.
   *
   * The engine assigns the letters, so they are sent rather than derived — a surface
   * that generated its own would disagree with the transcript and the debug log.
   */
  async question(turnId) {
    emit({ type: "turn:phase", turnId, phase: "awaiting_question" });
    emit({
      type: "question:requested",
      questionId: "qst_1",
      toolCallId: "c1",
      turnId,
      question: "Which worktree should the migration run in?",
      options: [
        { label: "A", text: "feature/db-migrate" },
        { label: "B", text: "main" },
        { label: "C", text: "Create a new worktree" },
      ],
      default: 0,
      requestedAt: now(),
    });

    const index = await awaitQuestion("qst_1");
    const options = ["feature/db-migrate", "main", "Create a new worktree"];
    const chosen = index >= 0 && index < options.length;
    emit({
      type: "question:answered",
      questionId: "qst_1",
      choiceIndex: chosen ? index : -1,
      cancelled: !chosen,
      answeredAt: now(),
      ...(chosen ? { label: ["A", "B", "C"][index], text: options[index] } : {}),
    });

    const answer = chosen
      ? `Running the migration in ${options[index]}.`
      : "You closed the question, so I'll leave the migration alone.";
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /** An accepted async call: settled, but the work continues in the background. */
  async asyncWork(turnId) {
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        {
          toolCallId: "c1",
          toolId: "agentTask.spawnForEdits",
          argsSummary: '{"worktreeId":"wt_forge"}',
          danger: true,
        },
      ],
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
    emit({ type: "tool:progress", toolCallId: "c1", message: "launching terminal", turnId });
    await sleep(80);
    emit({
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "agentTask.spawnForEdits",
      durationMs: 1200,
      result: "success",
      severity: "info",
      asyncId: "asy_1",
      asyncTitle: "migrate the schema in wt_forge",
      turnId,
    });
    // The real engine emits `tool:state(done)` after EVERY successful result, async or
    // not (internal/agent/session.go). Omitting it here would make this fake kinder
    // than production and let a consumer that mishandles the trailing frame pass —
    // which is the one failure mode a scriptable fake exists to prevent.
    emit({ type: "tool:state", toolCallId: "c1", state: "done", turnId });
    const answer = "Agent is running in wt_forge. I'll report back when it finishes.";
    await streamText(turnId, answer);
    emit({ type: "cost", turnId, total: 0.0412, complete: true });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /**
   * Prose, then a call the model composes only after finishing it.
   *
   * The window this exists for is the one between the two: the engine has left
   * `generating`, but the answer is still the last thing on screen because no tool row
   * has been announced yet. A streaming caret keyed on "the turn is unfinished and this
   * is the last segment" blinks all the way through it, parked at the end of a
   * paragraph the engine is done with.
   */
  async proseThenTool(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    await streamText(turnId, "Checking the worktrees now.", { chunk: 6, delay: 220, paced: true });
    emit({ type: "turn:phase", turnId, phase: "tool_queued" });
    await hold(2500);

    emit({
      type: "tool:batch",
      turnId,
      calls: [
        {
          toolCallId: "c1",
          toolId: "worktree.list",
          argsSummary: '{"status":"ready"}',
          danger: false,
          verb: "Listed worktrees",
        },
      ],
    });
    emit({ type: "turn:phase", turnId, phase: "tool_running" });
    emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
    emit({
      type: "tool:started",
      toolCallId: "c1",
      toolId: "worktree.list",
      argsSummary: "{}",
      startedAt: now(),
      turnId,
      danger: false,
    });
    await sleep(40);
    emit({
      type: "tool:settled",
      toolCallId: "c1",
      toolId: "worktree.list",
      durationMs: 120,
      result: "success",
      severity: "info",
      turnId,
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "done", turnId });

    emit({ type: "turn:phase", turnId, phase: "generating" });
    const answer = "Three worktrees are ready.";
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /** Reasoning is delivered whole, just before the turn ends. */
  async reasoning(turnId) {
    emit({ type: "turn:phase", turnId, phase: "thinking" });
    await sleep(60);
    emit({
      type: "turn:reasoning",
      turnId,
      text: "The user asked about worktrees; list them before answering.",
    });
    const answer = "Two worktrees are ahead of develop.";
    await streamText(turnId, answer);
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: answer });
  },

  /** A turn that fails outright. */
  async error(turnId) {
    emit({ type: "turn:phase", turnId, phase: "analyzing" });
    await sleep(50);
    emit({
      type: "host:error",
      code: "upstream_unavailable",
      message: "The model provider is unavailable. Try again shortly.",
    });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "unknown" });
  },

  /**
   * Streams slowly enough for the host to interrupt it. Exists because a cancelled
   * turn was the one outcome no test produced — and its outcome value was missing
   * from Daintree's schema entirely, so every cancellation had its `turn:end`
   * rejected. Never leave an outcome untested just because it is the sad path.
   */
  /** Dies mid-turn with a non-zero code — the failure the panel must settle from. */
  async crash(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    await streamText(turnId, "Starting the migration…");
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        {
          toolCallId: "c1",
          toolId: "agent.run",
          argsSummary: '{"task":"migrate"}',
          danger: false,
          verb: "Delegated",
          target: "migrate",
        },
      ],
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
    emit({ type: "turn:phase", turnId, phase: "tool_running" });
    // No turn:end, no shutdown frame, no terminal tool state: the process simply stops,
    // which is what a crash looks like from the host's side.
    await sleep(40);
    process.exit(9);
  },

  /** An autonomous WAKE turn — work the assistant started, which a user cannot stop. */
  async wake(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    await streamText(turnId, "I noticed CI went red on wt_forge and looked into it.");
    emit({
      type: "turn:end",
      turnId,
      endedAt: now(),
      outcome: "answered",
      content: "I noticed CI went red on wt_forge and looked into it.",
    });
  },

  async cancellable(turnId) {
    // Two calls in different states, so an interrupt has one of each to terminalize:
    // one that WAS running, and one announced but never started. The difference is
    // what tells a reader what the stop actually interrupted.
    emit({
      type: "tool:batch",
      turnId,
      calls: [
        { toolCallId: "c1", toolId: "agent.run", argsSummary: '{"task":"migrate"}', danger: false },
        { toolCallId: "c2", toolId: "git.status", argsSummary: "{}", danger: false },
      ],
    });
    emit({ type: "tool:state", toolCallId: "c1", state: "active", turnId });
    emit({ type: "turn:phase", turnId, phase: "generating" });
    await streamText(turnId, "This turn is long enough to interrupt. ".repeat(20), {
      chunk: 8,
      delay: 40,
    });
    // Held open until something INTERRUPTS it — not for a wall-clock 30 seconds.
    //
    // This scenario exists to be stopped, so it must not be able to end on its own. A
    // timed hold made the Stop and Escape tests race that timer on a loaded machine,
    // and it let them pass for the wrong reason when they lost: natural completion
    // removes the Stop button exactly as an interrupt does, so the assertion could not
    // tell "the interrupt worked" from "the turn finished by itself".
    while (!interrupted) await new Promise((r) => setTimeout(r, 50));
    if (!interrupted) {
      emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: "finished" });
    }
  },

  /** A long answer, for scroll and streaming-performance checks. */
  async long(turnId) {
    emit({ type: "turn:phase", turnId, phase: "generating" });
    const body = Array.from(
      { length: 24 },
      (_, i) => `${i + 1}. Step ${i + 1} — a line of explanation that wraps at panel width.`
    ).join("\n");
    await streamText(turnId, body, { chunk: 40, delay: 4 });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "answered", content: body });
  },
};

// ---------------------------------------------------------------------------
// Protocol loop
// ---------------------------------------------------------------------------

async function runTurn(text) {
  turnCounter += 1;
  const turnId = `turn_${turnCounter}`;
  interrupted = false;

  // The USER's own turn first — opened and closed in the same millisecond, carrying no
  // outcome. The real engine brackets every prompt this way (internal/host/bridge.go),
  // and a consumer that treats any `turn:end` as the end of the exchange settles on
  // this one. A fake that skipped it could never surface that class of bug.
  const userTurnId = `turn_${turnCounter}_user`;
  const at = now();
  emit({ type: "turn:start", turnId: userTurnId, role: "user", startedAt: at });
  emit({ type: "turn:end", turnId: userTurnId, endedAt: at });

  const wantsWake = /^\/scenario\s+wake\b/.test(text.trim());
  emit({
    type: "turn:start",
    turnId,
    role: "assistant",
    startedAt: now(),
    // `wake` marks a turn the ASSISTANT started. The panel disables Stop for these —
    // there is nothing of the user's to cancel — and that branch was unreachable from
    // any test because no scenario ever set the flag.
    ...(wantsWake ? { wake: true } : {}),
  });

  // A prompt may name a scenario inline (`/scenario approval`), so one session can
  // exercise several without respawning the process.
  const inline = /^\/scenario\s+(\w+)/.exec(text.trim());
  const name = inline ? inline[1] : SCENARIO;
  const scenario = SCENARIOS[name] ?? SCENARIOS.simple;

  try {
    await scenario(turnId);
  } catch (err) {
    emit({ type: "host:error", code: "fake_engine_error", message: String(err) });
    emit({ type: "turn:end", turnId, endedAt: now(), outcome: "unknown" });
  }
}

let busy = false;

async function handleCommand(cmd) {
  switch (cmd.type) {
    case "prompt": {
      if (busy) {
        // Mirrors the real engine: a prompt during a turn is folded into the RUNNING
        // turn as an interjection, not queued as a second turn.
        emit({ type: "turn:interjection", turnId: `turn_${turnCounter}`, text: cmd.text });
        return;
      }
      busy = true;
      await runTurn(cmd.text);
      busy = false;
      return;
    }
    case "approval:decide": {
      const resolve = pending.get(cmd.approvalId);
      if (resolve) {
        pending.delete(cmd.approvalId);
        resolve(cmd.decision);
      }
      return;
    }
    case "command": {
      // `/scenario <name>` is this fake's OWN command, and it must live on the command
      // path rather than the prompt path: the panel routes every slash line as a
      // command now, so a scenario trigger that only worked as a prompt would be
      // testing a route the product no longer takes.
      if (cmd.line.startsWith("/scenario")) {
        if (busy) return;
        busy = true;
        await runTurn(cmd.line);
        busy = false;
        return;
      }
      // Routed, never answered by the "model" — the whole point of the command path.
      //
      // Each answers with text unique to ITSELF. They all returned the same masthead
      // before, which made "the palette ran the command I picked" unprovable:
      // dispatching the wrong known command produced identical output and passed.
      const KNOWN = {
        "/status": `backend  local (http://127.0.0.1:8473)\ntier     operator`,
        "/help": "COMMANDS\n  /status   runtime and connections",
        "/clear":
          process.env.FAKE_ENGINE_CLEAR === "refuse"
            ? "Can't clear while a turn is in progress."
            : "Conversation cleared.",
        "/reconnect": "Reconnected to Daintree.",
        "/backend": "backend  local (http://127.0.0.1:8473)",
        "/watchers": "WATCHERS\n  wt_forge  claude  tier operator",
        "/inbox": "INBOX\n  nothing needs you right now",
      };
      const verb = cmd.line.split(/\s+/)[0];
      if (!(verb in KNOWN)) {
        emit({ type: "command:result", command: cmd.line, text: "", unknown: true });
        return;
      }
      emit({
        type: "command:result",
        command: cmd.line,
        text: KNOWN[verb],
        // Always present, as the real engine sends it. A host must not infer the clear
        // from the command text: the engine refuses `/clear` mid-turn, and the refusal
        // looks like any other result. FAKE_ENGINE_CLEAR=refuse exercises that half.
        conversationCleared: verb === "/clear" && process.env.FAKE_ENGINE_CLEAR !== "refuse",
      });
      return;
    }
    case "question:answer": {
      const resolve = pendingQuestions.get(cmd.questionId);
      if (resolve) {
        pendingQuestions.delete(cmd.questionId);
        // `choiceIndex` is REQUIRED on the wire, and the engine refuses the command
        // when it is absent rather than defaulting to the first option — so the fake
        // treats an absent one as a dismissal instead of quietly answering.
        resolve(typeof cmd.choiceIndex === "number" ? cmd.choiceIndex : -1);
      }
      return;
    }
    case "interrupt": {
      interrupted = true;
      // Terminalize outstanding calls BEFORE closing the turn, exactly as the engine
      // does: a consumer applying events in order must never see a turn close with
      // calls still live.
      for (const [id, state] of liveTools) {
        emit({
          type: "tool:state",
          toolCallId: id,
          state: state === "active" || state === "waiting" ? "cancelled" : "not-run",
          turnId: `turn_${turnCounter}`,
        });
      }
      liveTools.clear();
      emit({
        type: "turn:end",
        turnId: `turn_${turnCounter}`,
        endedAt: now(),
        outcome: "cancelled",
      });
      return;
    }
    case "operations": {
      // FAKE_ENGINE_OPERATIONS=empty answers with nothing in any section, which is what
      // makes the panel's omit-when-empty rule testable. With every section populated,
      // a deck that rendered seven empty headings satisfied every assertion.
      if (process.env.FAKE_ENGINE_OPERATIONS === "empty") {
        emit({
          type: "operations:snapshot",
          inbox: [],
          workflows: [],
          agents: [],
          async: [],
          timers: [],
          audit: [],
        });
        return;
      }
      // The deck is answered ON REQUEST, not streamed — the engine rebuilds it when
      // a host asks, because pushing every store change to a host that may not be
      // showing the deck is a great deal of traffic for a view nobody is looking at.
      //
      // One row in every section, so the panel's section ordering and its
      // omit-when-empty rule are both exercised by a single reading.
      operationsReads += 1;
      const at = now();
      emit({
        type: "operations:snapshot",
        inbox: [
          {
            id: "ib_1",
            severity: "attention",
            source: "watcher",
            summary: `wt_forge is waiting on a confirmation (reading ${operationsReads})`,
            at: at - 45_000,
          },
        ],
        workflows: [
          {
            id: "wf_1",
            goal: "Ship the migration",
            status: "running",
            progress: "3/5 done · current: Run tests",
            next: "Open the PR",
            blocked: false,
          },
        ],
        agents: [
          {
            id: "ag_1",
            title: "claude · wt_forge",
            goal: "Port the schema",
            badge: "",
            agentState: "working",
            preview: "$ npm test",
            startedAt: at - 300_000,
            needsAttention: false,
          },
        ],
        async: [
          { id: "as_1", title: "npm test", tool: "terminal.run.async", startedAt: at - 60_000 },
        ],
        timers: [{ id: "tm_1", label: "Re-check CI", dueAt: at + 900_000 }],
        audit: [{ tool: "fs.read", outcome: "ok", durationMs: 12, at: at - 5_000 }],
      });
      return;
    }
    case "hibernate":
    case "shutdown": {
      emit({
        type: "host:shutdown",
        reason: cmd.type === "hibernate" ? "hibernate" : "exit",
        ...(cmd.type === "hibernate" ? { resumeSessionId: `${sessionId}_resume` } : {}),
      });
      // Flush before exiting: stdout is a pipe, and process.exit() would discard
      // whatever is still buffered — including the shutdown frame just written.
      process.stdout.write("", () => process.exit(0));
      return;
    }
    default:
      return;
  }
}

const rl = createInterface({ input: process.stdin });
let handshakeDone = false;
/** Commands are serialized: a turn must finish before the next one starts. */
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // Foreign line: dropped, exactly as the engine drops it.
  }

  if (!handshakeDone) {
    handshakeDone = true;
    sessionId = msg.sessionId ?? "ses_fake";

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      // Refuse rather than guess — the real engine's behaviour, and the only way to
      // test Daintree's mismatch handling.
      emit({
        type: "host:error",
        code: "protocol-mismatch",
        message: `fake engine speaks v${PROTOCOL_VERSION}, host sent v${msg.protocolVersion}`,
      });
      emit({ type: "host:shutdown", reason: "error" });
      process.stdout.write("", () => process.exit(1));
      return;
    }

    // Diagnostics go to stderr. Anything written to stdout that is not a protocol
    // frame would be dropped by the host as an invalid event.
    process.stderr.write(`fake-assistant-engine: scenario=${SCENARIO} speed=${SPEED}\n`);

    emit({
      type: "host:ready",
      protocolVersion: PROTOCOL_VERSION,
      version: "fake-engine-1.0.0",
      // The catalog the engine sends at ready, so the panel's palette matches the
      // command set the engine will actually accept.
      commands: [
        // Advertised because this fake ACCEPTS it. The panel routes on the catalog, so
        // a command the engine serves but does not advertise would be sent as a prompt.
        { name: "/scenario", syntax: "/scenario <name>", palette: "run a scripted turn" },
        { name: "/status", syntax: "/status", palette: "runtime and connections" },
        { name: "/watchers", syntax: "/watchers", palette: "supervised agents" },
        { name: "/inbox", syntax: "/inbox [sev]", palette: "items requiring attention" },
      ],
      autoApprove: process.env.FAKE_ENGINE_AUTO_APPROVE === "1",
      // The session facts the masthead is drawn from. The real engine fills all of
      // these (internal/host/host.go); a fake that left them out meant every masthead
      // assertion was made against a session with no tier, no backend and no routing,
      // which is a state the product never reaches.
      tier: process.env.FAKE_ENGINE_TIER ?? "operator",
      tierGloss: "terminals, projects, external",
      backend: "local (http://127.0.0.1:8473)",
      routing: "daintree-fake",
      ...(msg.resumeSessionId ? { resumedSessionId: msg.resumeSessionId } : {}),
    });

    // AFTER host:ready, exactly as the engine posts it — a host cannot match events to
    // a session until it has been told the session id, so a status emitted before ready
    // is dropped. The panel's "Connected · no Daintree tools" branch reads this.
    emit({
      type: "mcp:status",
      connected: process.env.FAKE_ENGINE_MCP === "off" ? false : true,
      ...(process.env.FAKE_ENGINE_MCP === "off"
        ? { error: "DAINTREE_MCP_URL / DAINTREE_MCP_TOKEN not set" }
        : { toolCount: 42 }),
    });
    return;
  }

  // CONTROL commands are handled immediately; only `prompt` is serialized behind the
  // running turn.
  //
  // This is not a shortcut — it is the property the real engine goes out of its way
  // to preserve. An approval decision that queued behind the turn could never be
  // processed, because the turn is blocked WAITING for that decision: the session
  // would deadlock the first time a dangerous tool asked for confirmation. Same for
  // interrupt and shutdown, which exist precisely to act on a turn in flight.
  if (msg.type !== "prompt") {
    void handleCommand(msg);
    return;
  }
  queue = queue.then(() => handleCommand(msg)).catch(() => {});
});

rl.on("close", () => process.exit(0));
