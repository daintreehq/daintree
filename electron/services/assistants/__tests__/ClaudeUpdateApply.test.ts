import { describe, expect, it } from "vitest";
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
  type ClaudeUpdatePin,
  type ClaudeUpdateRecord,
} from "../ClaudeUpdateApply.js";

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

  it.each<[string, Partial<ClaudeUpdateRecord>]>([
    ["another agent", { detectedAgentId: "codex" }],
    ["no detected agent", { detectedAgentId: undefined }],
    ["no update observation", { updateInstalled: undefined }],
    [
      "a footer that didn't name /restart",
      { updateInstalled: { observedAt: 900, namesRestart: false } },
    ],
  ])("refuses a pane with %s as not offering /restart", async (_name, extra) => {
    const { fake, service } = harness({ record: atPrompt(extra) });
    const error = await refusal(service.preflight(TERMINAL, undefined, OWNER));
    expect(error.code).toBe(CLAUDE_UPDATE_NOT_OFFERED);
    expect(error.message).toContain("Nothing was sent.");
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

  it.each<[string, Partial<ClaudeUpdateRecord>]>([
    ["a person's draft", { lastTypedInputAt: 1_500, lastForeignInputAt: 1_500 }],
    [
      "the caller's own keys",
      { lastTypedInputAt: 1_500, lastOwnedInput: { owner: OWNER, at: 1_500 } },
    ],
    ["a submission going in", { hasPendingSubmission: true }],
    ["no settle seen", { lastStateChange: undefined }],
  ])("refuses a pane holding %s", async (_name, extra) => {
    const { service } = harness({ record: atPrompt(extra) });
    expect((await refusal(service.preflight(TERMINAL, undefined, OWNER))).code).toBe(
      WORKER_STEER_REFUSALS.typing
    );
  });
});

describe("ClaudeUpdateApply.apply", () => {
  it("types /restart alone, once, under the exact guard pinned to the run and observation", async () => {
    const { fake, service, pin } = await pinned();
    const result = await service.apply(pin, allow);
    expect(fake.submits).toHaveLength(1);
    expect(fake.submits[0]).toMatchObject({
      terminalId: TERMINAL,
      text: CLAUDE_RESTART_COMMAND,
      owner: OWNER,
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
