import { describe, expect, it, vi } from "vitest";
import { WORKER_STEER_REFUSALS } from "../../../../shared/types/assistantControl.js";
import {
  CLAUDE_UPDATE_NOT_OFFERED,
  CLAUDE_UPDATE_WAIT_MS,
} from "../../../../shared/types/claudeUpdateApply.js";
import type { ExactPromptGuard } from "../../../../shared/types/pty-host.js";
import type { TerminalSubmissionRecord } from "../../../../shared/types/terminalSubmission.js";
import { AssistantTargetError } from "../AssistantTerminalControl.js";
import {
  CLAUDE_RESTART_COMMAND,
  ClaudeUpdateApply,
  liveClaudeUpdateApply,
  type ClaudeUpdatePin,
  type ClaudeUpdateRecord,
} from "../ClaudeUpdateApply.js";
import type { PtyClient } from "../../PtyClient.js";

const TERMINAL = "term-worker";
const OWNER = "principal-a";

interface Submit {
  terminalId: string;
  text: string;
  token: string;
  guard: ExactPromptGuard;
  owner: string;
}

interface Fake {
  now: number;
  generation: number | null;
  record: ClaudeUpdateRecord | null;
  submits: Submit[];
  withdrawn: string[];
  submissions: Map<string, TerminalSubmissionRecord>;
  /** What the terminal makes of a line it is handed. */
  onSubmit: (submit: Submit, fake: Fake) => void;
  /** Changes the pane between polls. */
  onSleep: (fake: Fake) => void;
  /** Runs inside each record read, before it answers: time can pass there. */
  beforeRead?: (fake: Fake, token?: string) => void;
}

function atPrompt(extra: Partial<ClaudeUpdateRecord> = {}): ClaudeUpdateRecord {
  return {
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 1_000,
    hasPty: true,
    agentIncarnation: 2,
    agentSessionId: "session-1",
    updateInstalled: { observedAt: 900, namesRestart: true },
    ...extra,
  };
}

/** The terminal takes the line and draws `output` after its Enter. */
const written =
  (text = "❯ /restart", state: "capturing" | "closed" | "lost" = "capturing") =>
  (submit: Submit, fake: Fake) => {
    fake.submissions.set(submit.token, {
      token: submit.token,
      phase: "pty_written",
      at: fake.now,
      output: { text, truncated: false, state },
    });
  };

function harness(overrides: Partial<Fake> = {}) {
  const fake: Fake = {
    now: 10_000,
    generation: 4,
    record: atPrompt(),
    submits: [],
    withdrawn: [],
    submissions: new Map(),
    onSubmit: written(),
    onSleep: () => {},
    ...overrides,
  };
  const service = new ClaudeUpdateApply({
    getTerminal: async (_terminalId, token) => {
      fake.beforeRead?.(fake, token);
      if (fake.record === null) return null;
      if (token === undefined) return { ...fake.record };
      const submission = fake.submissions.get(token);
      return { ...fake.record, ...(submission ? { submission } : {}) };
    },
    getLiveGeneration: () => fake.generation,
    submit: (terminalId, text, token, guard, owner) => {
      const submit = { terminalId, text, token, guard, owner };
      fake.submits.push(submit);
      fake.onSubmit(submit, fake);
    },
    withdraw: (_terminalId, token) => fake.withdrawn.push(token),
    now: () => fake.now,
    sleep: async (ms) => {
      fake.now += ms;
      fake.onSleep(fake);
    },
  });
  return { fake, service };
}

async function refusal(promise: Promise<unknown>): Promise<AssistantTargetError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AssistantTargetError);
  return error as AssistantTargetError;
}

const allow = { inputOwner: OWNER, authorize: () => {} };

async function pinned(fake?: Partial<Fake>) {
  const built = harness(fake);
  const pin = await built.service.preflight(TERMINAL, undefined, OWNER);
  return { ...built, pin };
}

describe("ClaudeUpdateApply.preflight", () => {
  it("pins the run, the observation and the last prompt input it read", async () => {
    const { pin } = await pinned({
      record: atPrompt({ worktreeId: "wt-1", lastForeignPromptInputAt: 500 }),
    });
    expect(pin).toEqual<ClaudeUpdatePin>({
      terminalId: TERMINAL,
      generation: 4,
      agentIncarnation: 2,
      agentSessionId: "session-1",
      worktreeId: "wt-1",
      observedAt: 900,
      promptInputAt: 500,
    });
  });

  it.each<[string, Partial<ClaudeUpdateRecord>, RegExp]>([
    ["another agent", { detectedAgentId: "codex" }, /it runs codex/],
    ["no detected agent", { detectedAgentId: undefined }, /no agent is detected/],
    ["no update observation", { updateInstalled: undefined }, /hasn't shown/],
    [
      "a footer that didn't name /restart",
      { updateInstalled: { observedAt: 900, namesRestart: false } },
      /didn't name \/restart/,
    ],
  ])("refuses a pane with %s as not offering /restart", async (_name, extra, why) => {
    const { fake, service } = harness({ record: atPrompt(extra) });
    const error = await refusal(service.preflight(TERMINAL, undefined, OWNER));
    expect(error.code).toBe(CLAUDE_UPDATE_NOT_OFFERED);
    expect(error.message).toMatch(why);
    expect(error.message).toContain("Nothing was sent.");
    expect(fake.submits).toEqual([]);
  });

  it("refuses a run replaced while its record was being read", async () => {
    const { fake, service } = harness({
      beforeRead: (f) => {
        f.generation = 5;
      },
    });
    expect((await refusal(service.preflight(TERMINAL, 4, OWNER))).code).toBe(
      WORKER_STEER_REFUSALS.restarted
    );
    expect(fake.submits).toEqual([]);
  });

  it.each<[string, Partial<ClaudeUpdateRecord>]>([
    ["an assistant", { isAssistantTerminal: true }],
    ["an exited process", { isExited: true }],
    ["no PTY", { hasPty: false }],
    ["the trash", { isTrashed: true }],
    ["an agent being quit", { isClosing: true }],
  ])("refuses %s as no worker to update", async (_name, extra) => {
    const { service } = harness({ record: atPrompt(extra) });
    expect((await refusal(service.preflight(TERMINAL, undefined, OWNER))).code).toBe(
      WORKER_STEER_REFUSALS.notAgent
    );
  });

  it("refuses a run the caller didn't name", async () => {
    const { service } = harness();
    expect((await refusal(service.preflight(TERMINAL, 3, OWNER))).code).toBe(
      WORKER_STEER_REFUSALS.restarted
    );
  });

  it("refuses a terminal that isn't running or can't be read", async () => {
    expect(
      (await refusal(harness({ generation: null }).service.preflight(TERMINAL, undefined, OWNER)))
        .code
    ).toBe(WORKER_STEER_REFUSALS.notFound);
    expect(
      (await refusal(harness({ record: null }).service.preflight(TERMINAL, undefined, OWNER))).code
    ).toBe(WORKER_STEER_REFUSALS.notFound);
  });

  it.each<[string, Partial<ClaudeUpdateRecord>, RegExp]>([
    [
      "a person's draft",
      { lastTypedInputAt: 1_500, lastForeignInputAt: 1_500 },
      /Someone has typed/,
    ],
    [
      "the caller's own keys",
      { lastTypedInputAt: 1_500, lastOwnedInput: { owner: OWNER, at: 1_500 } },
      /keys you sent/,
    ],
    ["a submission going in", { hasPendingSubmission: true }, /still being written/],
    ["no settle seen", { lastStateChange: undefined }, /hasn't been seen settling/],
  ])("refuses a pane holding %s", async (_name, extra, why) => {
    const { service } = harness({ record: atPrompt(extra) });
    const error = await refusal(service.preflight(TERMINAL, undefined, OWNER));
    expect(error.code).toBe(WORKER_STEER_REFUSALS.typing);
    expect(error.message).toMatch(why);
  });
});

describe("ClaudeUpdateApply.apply", () => {
  it("types /restart alone, once, under the exact guard pinned to the run and observation", async () => {
    const { fake, service, pin } = await pinned();
    const result = await service.apply(pin, allow);
    expect(fake.submits).toHaveLength(1);
    expect(fake.submits[0]).toEqual({
      terminalId: TERMINAL,
      text: CLAUDE_RESTART_COMMAND,
      token: expect.any(String),
      owner: OWNER,
      // Never widened: no mid-turn queueing and no question taken as its prompt.
      guard: {
        kind: "settled-prompt-exact",
        agentIncarnation: 2,
        agentSessionId: "session-1",
        updateObservedAt: 900,
      },
    });
    expect(fake.submits[0]!.text).toBe("/restart");
    expect(result).toMatchObject({ terminalId: TERMINAL, status: "sent", refusal: null });
    expect(result.output).toBe("read");
    expect(result.message).toContain("isn't known");
  });

  it("waits out a working turn and sends once the pane settles, never twice", async () => {
    let polls = 0;
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    fake.onSleep = (f) => {
      polls += 1;
      if (polls === 5) f.record = atPrompt({ lastStateChange: f.now });
    };
    const result = await service.apply(pin, allow);
    expect(result.status).toBe("sent");
    expect(fake.submits).toHaveLength(1);
  });

  it.each<[string, (fake: Fake) => void, string]>([
    [
      "a person typing a prompt",
      (f) => (f.record = { ...f.record!, lastForeignPromptInputAt: f.now }),
      "typed",
    ],
    [
      "another prompt of the caller's own",
      (f) => (f.record = { ...f.record!, lastOwnedPromptInput: { owner: OWNER, at: f.now } }),
      "typed",
    ],
    ["a relaunch under a new generation", (f) => (f.generation = 5), "restarted"],
    [
      "another agent run in the PTY",
      (f) => (f.record = { ...f.record!, agentIncarnation: 3 }),
      "restarted",
    ],
    [
      "a new session",
      (f) => (f.record = { ...f.record!, agentSessionId: "session-2" }),
      "restarted",
    ],
    [
      "Claude leaving",
      (f) => (f.record = { ...f.record!, detectedAgentId: undefined }),
      "restarted",
    ],
    [
      "the observation cleared",
      (f) => (f.record = { ...f.record!, updateInstalled: undefined }),
      "observation-changed",
    ],
    [
      "the observation made anew",
      (f) =>
        (f.record = { ...f.record!, updateInstalled: { observedAt: 9_999, namesRestart: true } }),
      "observation-changed",
    ],
    [
      "the footer no longer naming /restart",
      (f) =>
        (f.record = { ...f.record!, updateInstalled: { observedAt: 900, namesRestart: false } }),
      "observation-changed",
    ],
    [
      "the pane going to the trash",
      (f) => (f.record = { ...f.record!, isTrashed: true }),
      "target-gone",
    ],
  ])("drops it unsent on %s while it waits", async (_name, change, reason) => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    fake.onSleep = (f) => {
      change(f);
      // Settled again, so only the change can be what stops it.
      if (f.record)
        f.record = {
          ...f.record,
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: f.now,
        };
    };
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "not-sent", reason });
    expect(result.message).toContain("Nothing was sent.");
    expect(fake.submits).toEqual([]);
  });

  it("expires unsent when the pane never waits at an empty prompt", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "waiting", waitingReason: "approval" });
    const started = fake.now;
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "not-sent", reason: "expired" });
    expect(result.message).toContain("approval");
    expect(fake.now - started).toBeLessThanOrEqual(CLAUDE_UPDATE_WAIT_MS);
    expect(fake.submits).toEqual([]);
  });

  it("never types at a question asked in prose, which is no empty prompt", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ waitingReason: "question" });
    expect((await service.apply(pin, allow)).reason).toBe("expired");
    expect(fake.submits).toEqual([]);
  });

  it("ends its wait at the caller's deadline", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    const started = fake.now;
    const result = await service.apply(pin, { ...allow, deadline: started + 1_000 });
    expect(result.reason).toBe("expired");
    expect(fake.now - started).toBeLessThan(1_500);
  });

  it("stops when the call is cancelled", async () => {
    const { fake, service, pin } = await pinned();
    const controller = new AbortController();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    fake.onSleep = () => controller.abort();
    const result = await service.apply(pin, { ...allow, signal: controller.signal });
    expect(result).toMatchObject({ status: "not-sent", reason: "cancelled" });
    expect(fake.submits).toEqual([]);
  });

  it("sends nothing when the caller may no longer act there", async () => {
    const { fake, service, pin } = await pinned();
    const result = await service.apply(pin, {
      inputOwner: OWNER,
      authorize: () => {
        throw new AssistantTargetError("DRIVEN_ELSEWHERE", "Another window drives this project.");
      },
    });
    expect(result).toMatchObject({ status: "not-sent", reason: "not-allowed" });
    expect(result.message).toContain("Another window drives this project.");
    expect(fake.submits).toEqual([]);
  });

  it.each([
    "Can't restart automatically. Type /restart at the prompt.",
    "Can't restart while work is running in the background. Wait for it to finish or stop it in /tasks, then try again.",
    "Can't restart while Remote Control is connected. Disconnect it, then try again.",
    "Can't restart this session. It isn't saved to disk, so there's nothing to resume.",
    "Can't restart this session here. Its folder, /Users/me/app, can't be found. Open it again.",
    "Can't restart. The installed version wasn't found. Run claude update.",
    "Can't restart on the installed version. Version 2.1.329 is on hold, so this keeps 2.1.328.",
  ])("reports Claude's refusal verbatim and ends there: %s", async (line) => {
    const { fake, service, pin } = await pinned({
      onSubmit: written(`❯ /restart\n  ⎿  ${line}`),
    });
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "sent", refusal: line, output: "read" });
    expect(fake.submits).toHaveLength(1);
  });

  it("reads a refusal drawn a moment after the Enter", async () => {
    const { fake, service, pin } = await pinned();
    let polls = 0;
    fake.onSleep = (f) => {
      polls += 1;
      const token = f.submits[0]?.token;
      if (token !== undefined && polls === 3) {
        written("❯ /restart\n  ⎿  Can't restart automatically. Type /restart at the prompt.")(
          f.submits[0]!,
          f
        );
      }
    };
    const result = await service.apply(pin, allow);
    expect(result.refusal).toBe("Can't restart automatically. Type /restart at the prompt.");
  });

  it("says when the answer couldn't be read, without claiming no refusal", async () => {
    const lost = await pinned({ onSubmit: written("❯ /restart", "lost") });
    expect(await lost.service.apply(lost.pin, allow)).toMatchObject({
      status: "sent",
      refusal: null,
      output: "lost",
    });
    const none = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase: "pty_written", at: f.now }),
    });
    const result = await none.service.apply(none.pin, allow);
    expect(result).toMatchObject({ status: "sent", refusal: null, output: "unavailable" });
    expect(result.message).toContain("can't be ruled out");
  });

  it("reports a line the terminal refused as it arrived as withheld", async () => {
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase: "cancelled", at: f.now }),
    });
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "not-sent", reason: "withheld" });
    expect(fake.submits).toHaveLength(1);
  });

  it.each<[TerminalSubmissionRecord["phase"]]>([["failed"], ["unknown"]])(
    "calls a line that ended %s unconfirmed, never resent",
    async (phase) => {
      const { fake, service, pin } = await pinned({
        onSubmit: (submit, f) =>
          f.submissions.set(submit.token, { token: submit.token, phase, at: f.now }),
      });
      expect((await service.apply(pin, allow)).status).toBe("unconfirmed");
      expect(fake.submits).toHaveLength(1);
    }
  );

  it("takes back a line the terminal never wrote, and calls it unconfirmed", async () => {
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase: "queued", at: f.now }),
    });
    const result = await service.apply(pin, allow);
    expect(result.status).toBe("unconfirmed");
    expect(fake.withdrawn).toEqual([fake.submits[0]!.token]);
  });
});

describe("ClaudeUpdateApply.exclusive", () => {
  it("refuses a second request for a pane while one is open, and frees it after", async () => {
    const { service } = harness();
    let release!: () => void;
    const first = service.exclusive(TERMINAL, () => new Promise<void>((r) => (release = r)));
    const second = await refusal(service.exclusive(TERMINAL, async () => {}));
    expect(second.code).toBe(WORKER_STEER_REFUSALS.busy);
    release();
    await first;
    await expect(service.exclusive(TERMINAL, async () => "again")).resolves.toBe("again");
  });
});

describe("ClaudeUpdateApply.apply, at its edges", () => {
  it("types nothing while the pane is busy, and once when it settles", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    const submitsWhileBusy: number[] = [];
    let polls = 0;
    fake.onSleep = (f) => {
      polls += 1;
      if (f.record?.agentState === "working") submitsWhileBusy.push(f.submits.length);
      if (polls === 4) f.record = atPrompt({ lastStateChange: f.now });
    };
    await service.apply(pin, allow);
    expect(submitsWhileBusy).toEqual([0, 0, 0, 0]);
    expect(fake.submits).toHaveLength(1);
  });

  it("waits out a submission someone else started after the approval", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ hasPendingSubmission: true });
    let polls = 0;
    fake.onSleep = (f) => {
      polls += 1;
      if (polls === 3) f.record = atPrompt();
    };
    expect((await service.apply(pin, allow)).status).toBe("sent");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("says it waited at a question, and types there only once the prompt is empty", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ waitingReason: "question" });
    const result = await service.apply(pin, allow);
    expect(result.reason).toBe("expired");
    expect(result.message).toContain("question");
    expect(fake.submits).toEqual([]);
  });

  it.each<[string, Partial<ClaudeUpdateRecord>]>([
    [
      "foreign input newer",
      { lastForeignPromptInputAt: 700, lastOwnedPromptInput: { owner: OWNER, at: 400 } },
    ],
    [
      "the caller's own input newer",
      { lastForeignPromptInputAt: 400, lastOwnedPromptInput: { owner: OWNER, at: 700 } },
    ],
  ])("pins the newest prompt input of anyone, %s", async (_name, extra) => {
    const { fake, service, pin } = await pinned({ record: atPrompt(extra) });
    expect(pin.promptInputAt).toBe(700);
    // Unchanged input lets it go...
    expect((await service.apply(pin, allow)).status).toBe("sent");
    // ...and input newer than the pin, of either kind, drops it.
    for (const later of [
      { lastForeignPromptInputAt: 701 },
      { lastOwnedPromptInput: { owner: OWNER, at: 701 } },
    ]) {
      fake.record = atPrompt({ ...extra, ...later });
      fake.submits = [];
      expect((await service.apply(pin, allow)).reason).toBe("typed");
      expect(fake.submits).toEqual([]);
    }
  });

  it("drops it when the pane moves to another worktree", async () => {
    const { fake, service, pin } = await pinned({ record: atPrompt({ worktreeId: "wt-1" }) });
    fake.record = atPrompt({ worktreeId: "wt-2" });
    expect((await service.apply(pin, allow)).reason).toBe("restarted");
    expect(fake.submits).toEqual([]);
  });

  it("types nothing when the ready read answers after the time ran out", async () => {
    const { fake, service, pin } = await pinned();
    const started = fake.now;
    fake.beforeRead = (f) => {
      f.now = started + 2_000;
    };
    const result = await service.apply(pin, { ...allow, deadline: started + 1_000 });
    expect(result).toMatchObject({ status: "not-sent", reason: "expired" });
    expect(fake.submits).toEqual([]);
  });

  it("types nothing when the call ends while the ready read is out", async () => {
    const { fake, service, pin } = await pinned();
    const controller = new AbortController();
    fake.beforeRead = () => controller.abort();
    const result = await service.apply(pin, { ...allow, signal: controller.signal });
    expect(result).toMatchObject({ status: "not-sent", reason: "cancelled" });
    expect(fake.submits).toEqual([]);
  });

  it("holds the full wait before it expires", async () => {
    const { fake, service, pin } = await pinned();
    fake.record = atPrompt({ agentState: "working", waitingReason: undefined });
    const started = fake.now;
    await service.apply(pin, allow);
    expect(fake.now - started).toBeGreaterThan(CLAUDE_UPDATE_WAIT_MS - 1_000);
  });

  it("asks to take back a line still queued when the call ends, and reports what became of it", async () => {
    const controller = new AbortController();
    let reads = 0;
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) => {
        f.submissions.set(submit.token, { token: submit.token, phase: "queued", at: f.now });
        controller.abort();
      },
      beforeRead: (f, token) => {
        if (token === undefined) return;
        reads += 1;
        if (reads === 3) {
          f.submissions.set(token, { token, phase: "cancelled", at: f.now });
        }
      },
    });
    const result = await service.apply(pin, { ...allow, signal: controller.signal });
    expect(fake.withdrawn).toEqual([fake.submits[0]!.token]);
    expect(result).toMatchObject({ status: "not-sent", reason: "withheld" });
  });

  it("takes the line back the moment the call ends, not at its next read", async () => {
    const controller = new AbortController();
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase: "writing", at: f.now }),
    });
    let withdrawnAtAbort: string[] = [];
    fake.beforeRead = (f, token) => {
      if (token === undefined || controller.signal.aborted) return;
      controller.abort();
      // Synchronous with the abort, inside a read still out.
      withdrawnAtAbort = [...f.withdrawn];
      f.submissions.set(token, { token, phase: "cancelled", at: f.now });
    };
    const result = await service.apply(pin, { ...allow, signal: controller.signal });
    expect(withdrawnAtAbort).toEqual([fake.submits[0]!.token]);
    expect(fake.withdrawn).toHaveLength(1);
    expect(result).toMatchObject({ status: "not-sent", reason: "withheld" });
  });

  it("quotes a refusal only once it stops growing past one repeated read", async () => {
    const partial = "❯ /restart\n  ⎿  Can't restart while Remote Control is";
    const whole = `${partial} connected. Disconnect it.`;
    const { fake, service, pin } = await pinned({ onSubmit: written(partial) });
    let reads = 0;
    fake.beforeRead = (f, token) => {
      if (token === undefined) return;
      reads += 1;
      // The capture repeats the half row once before it publishes the rest.
      if (reads === 3) written(whole)(f.submits[0]!, f);
    };
    expect((await service.apply(pin, allow)).refusal).toBe(
      "Can't restart while Remote Control is connected. Disconnect it."
    );
  });

  it("keeps a lost capture marked lost even with a refusal in it", async () => {
    const { service, pin } = await pinned({
      onSubmit: written("❯ /restart\n  ⎿  Can't restart automatically. Type it.", "lost"),
    });
    expect(await service.apply(pin, allow)).toMatchObject({
      refusal: "Can't restart automatically. Type it.",
      output: "lost",
    });
  });

  it.each<[TerminalSubmissionRecord["phase"], RegExp]>([
    ["failed", /failed partway/],
    ["unknown", /holds no record/],
  ])("answers a line that ended %s at once, never taking it back", async (phase, why) => {
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase, at: f.now }),
    });
    const started = fake.now;
    const result = await service.apply(pin, allow);
    expect(result.status).toBe("unconfirmed");
    expect(result.message).toMatch(why);
    expect(fake.withdrawn).toEqual([]);
    expect(fake.now - started).toBeLessThan(1_000);
  });

  it("asks to take back a stuck line once, only after its delivery time", async () => {
    let askedAt: number | undefined;
    const { fake, service, pin } = await pinned({
      onSubmit: (submit, f) =>
        f.submissions.set(submit.token, { token: submit.token, phase: "writing", at: f.now }),
    });
    const handedAt = fake.now;
    const original = fake.withdrawn.push.bind(fake.withdrawn);
    fake.withdrawn.push = (...tokens: string[]) => {
      askedAt = fake.now;
      return original(...tokens);
    };
    const result = await service.apply(pin, allow);
    expect(fake.withdrawn).toHaveLength(1);
    expect(askedAt! - handedAt).toBeGreaterThanOrEqual(5_000);
    expect(result.message).toContain("unknown");
  });

  it("reads a refusal drawn just before the watch ends", async () => {
    const { fake, service, pin } = await pinned();
    const line = "Can't restart automatically. Type /restart at the prompt.";
    fake.onSleep = (f) => {
      const submit = f.submits[0];
      if (submit === undefined) return;
      const record = f.submissions.get(submit.token)!;
      if (f.now - record.at! >= 3_800) written(`❯ /restart\n  ⎿  ${line}`)(submit, f);
    };
    expect((await service.apply(pin, allow)).refusal).toBe(line);
  });

  it("quotes a refusal whole when it was first read half drawn", async () => {
    const { fake, service, pin } = await pinned({
      onSubmit: written("❯ /restart\n  ⎿  Can't restart while Remote Control is"),
    });
    fake.onSleep = (f) => {
      const submit = f.submits[0];
      if (submit === undefined) return;
      written("❯ /restart\n  ⎿  Can't restart while Remote Control is connected. Disconnect it.")(
        submit,
        f
      );
    };
    expect((await service.apply(pin, allow)).refusal).toBe(
      "Can't restart while Remote Control is connected. Disconnect it."
    );
  });

  it("reads no refusal into an earlier attempt's answer above this line's echo", async () => {
    const { service, pin } = await pinned({
      onSubmit: written(
        [
          "❯ /restart",
          "  ⎿  Can't restart automatically. Type /restart at the prompt.",
          "❯ /restart",
          "",
        ].join("\n"),
        "closed"
      ),
    });
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "sent", refusal: null, output: "read" });
    expect(result.message).toContain("no refusal");
    expect(result.message).toContain("isn't known");
  });

  it.each<[string, (submit: Submit, fake: Fake) => void]>([
    ["capture lost", written("❯ /restart", "lost")],
    [
      "capture cut short",
      (submit, f) =>
        f.submissions.set(submit.token, {
          token: submit.token,
          phase: "pty_written",
          at: f.now,
          output: { text: "❯ /restart", truncated: true, state: "closed" },
        }),
    ],
  ])("never says none was seen when the answer was %s", async (_name, onSubmit) => {
    const { service, pin } = await pinned({ onSubmit });
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "sent", refusal: null, output: "lost" });
    expect(result.message).toContain("can't be ruled out");
  });

  it("calls the answer lost once its line can no longer be followed", async () => {
    const { fake, service, pin } = await pinned();
    fake.onSleep = (f) => {
      // The relaunch took the record with it: later reads find no line.
      f.submissions.clear();
    };
    const result = await service.apply(pin, allow);
    expect(result).toMatchObject({ status: "sent", refusal: null, output: "lost" });
  });
});

describe("liveClaudeUpdateApply", () => {
  it("hands the pty host the literal line under the guard, as nobody's prompt and with no handback", async () => {
    const submit = vi.fn();
    const pty = {
      getTerminalAsync: vi.fn(async (_id: string, token?: string) =>
        token === undefined
          ? atPrompt()
          : {
              ...atPrompt(),
              submission: {
                token,
                phase: "pty_written",
                at: 1,
                output: { text: "❯ /restart", truncated: false, state: "closed" },
              },
            }
      ),
      getLiveGeneration: vi.fn(() => 4),
      submit,
      withdrawGuardedSubmission: vi.fn(),
      write: vi.fn(),
    };
    const service = liveClaudeUpdateApply(() => pty as unknown as PtyClient);
    const pin = await service.preflight(TERMINAL, 4, OWNER);
    await service.apply(pin, allow);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual([
      TERMINAL,
      "/restart",
      expect.any(String),
      undefined,
      {
        kind: "settled-prompt-exact",
        agentIncarnation: 2,
        agentSessionId: "session-1",
        updateObservedAt: 900,
      },
      undefined,
      null,
      undefined,
      OWNER,
    ]);
    expect(pty.write).not.toHaveBeenCalled();
  });
});
