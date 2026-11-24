import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerSendHold } from "../ComposerSendHold.js";
import type { LaneWake, NotifyTerminalInfo } from "../../mcp-server/terminalNotify.js";
import {
  COMPOSER_HOLD_TTL_MS,
  type ComposerHoldChange,
} from "../../../../shared/types/ipc/composerHold.js";
import type { TerminalSubmissionPhase } from "../../../../shared/types/terminalSubmission.js";

const PROJECT = "project-1";
const T = "term-1";
const T2 = "term-2";

function working(overrides: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return {
    projectId: PROJECT,
    agentState: "working",
    lastStateChange: 1_000,
    detectedAgentId: "gemini",
    hasPty: true,
    agentIncarnation: 1,
    ...overrides,
  };
}

function atPrompt(overrides: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return working({
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 5_000,
    ...overrides,
  });
}

function setup() {
  let now = 10_000;
  let token = 0;
  const wakes: LaneWake[] = [];
  const release = vi.fn();
  const openWakes = vi.fn(() => ({
    queueWake: (_pane: unknown, _projectId: string, wake: LaneWake) => {
      wakes.push(wake);
    },
    release,
  }));
  const generations = new Map<string, number>([
    [T, 7],
    [T2, 3],
  ]);
  const projects = new Map<string, string>([
    [T, PROJECT],
    [T2, PROJECT],
  ]);
  const driving = { value: true };
  const terminals = new Map<string, NotifyTerminalInfo | null>([[T, working()]]);
  /** What the host recorded of each submission token, read with its terminal. */
  const submissions = new Map<string, TerminalSubmissionPhase>();
  const readTerminal = vi.fn(async (terminalId: string, submissionToken?: string) => {
    const info = terminals.get(terminalId) ?? null;
    const phase = submissionToken === undefined ? undefined : submissions.get(submissionToken);
    if (info === null || phase === undefined) return info;
    return { ...info, submission: { token: submissionToken!, phase } };
  });
  const submit =
    vi.fn<
      (terminalId: string, text: string, token: string, imagePaths: readonly string[]) => void
    >();
  const published: ComposerHoldChange[] = [];
  const hold = new ComposerSendHold({
    openWakes,
    paneFor: (terminalId) => ({ key: `worker\u0000${terminalId}`, terminalId }),
    getLiveGeneration: (terminalId) => generations.get(terminalId) ?? null,
    getTerminalProjectId: (terminalId) => projects.get(terminalId) ?? null,
    readTerminal,
    submit,
    publish: (_projectId, change) => published.push(change),
    now: () => now,
    newToken: () => `token-${++token}`,
  });
  const request = (text = "fix the tests", info = working(), terminalId = T) =>
    hold.hold({
      terminalId,
      projectId: PROJECT,
      generation: generations.get(terminalId)!,
      text,
      imagePaths: ["/tmp/shot.png"],
      info,
      authorize: () => driving.value,
    });
  const ended = () => published.flatMap((change) => (change.ended ? [change.ended.outcome] : []));
  const sendNow = (
    token: string,
    overrides: { inputBlocked?: boolean; drives?: boolean | (() => boolean) } = {}
  ) => {
    const { drives = true } = overrides;
    return hold.sendNow({
      terminalId: T,
      token,
      projectId: PROJECT,
      inputBlocked: overrides.inputBlocked ?? false,
      authorize: typeof drives === "function" ? drives : () => drives,
    });
  };
  return {
    hold,
    wakes,
    release,
    openWakes,
    generations,
    projects,
    terminals,
    published,
    request,
    sendNow,
    submit,
    submissions,
    readTerminal,
    ended,
    driving,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ComposerSendHold", () => {
  it("holds one send per pane and refuses another while it waits", () => {
    const h = setup();
    const first = h.request();
    expect(first).toMatchObject({ ok: true, send: { terminalId: T, status: "held" } });
    expect(h.published.at(-1)?.held?.text).toBe("fix the tests");

    expect(h.request("again")).toEqual({ ok: false, reason: "already-held" });
    expect(h.request("elsewhere", working(), T2).ok).toBe(true);
    expect(h.request("again", working(), T2)).toEqual({ ok: false, reason: "already-held" });
    expect(h.wakes).toHaveLength(2);
  });

  it("is ready only at the agent's own prompt", () => {
    const h = setup();
    h.request();
    const [wake] = h.wakes;
    expect(wake!.recheck(working()).kind).toBe("held");
    expect(wake!.recheck(atPrompt({ waitingReason: "question" })).kind).toBe("held");
    expect(wake!.recheck(atPrompt({ waitingReason: "approval" })).kind).toBe("held");
    expect(wake!.recheck(atPrompt())).toEqual({ kind: "ready" });
  });

  it("waits out a choice dialog it was sent at, keys and all, and goes at the next prompt", () => {
    const h = setup();
    const atDialog = atPrompt({ waitingReason: "approval", lastStateChange: 9_000 });
    h.request("held at a dialog", atDialog);
    const [wake] = h.wakes;
    // Keys that answer the dialog after it was held are typed input, but never prompt input.
    h.advance(1_000);
    expect(wake!.recheck({ ...atDialog, lastTypedInputAt: 11_000 }).kind).toBe("held");
    h.advance(1_000);
    expect(wake!.recheck(working({ lastStateChange: 11_500, lastTypedInputAt: 11_000 })).kind).toBe(
      "held"
    );
    h.advance(1_000);
    expect(wake!.recheck(atPrompt({ lastStateChange: 12_500, lastTypedInputAt: 11_000 }))).toEqual({
      kind: "ready",
    });
    expect(h.ended()).toEqual([]);
  });

  it("drops on input that reached the prompt after it was held, not before", () => {
    const h = setup();
    h.request("held", working({ lastForeignPromptInputAt: 900 }));
    const [wake] = h.wakes;
    expect(wake!.recheck(atPrompt({ lastForeignPromptInputAt: 900 }))).toEqual({ kind: "ready" });

    expect(wake!.recheck(atPrompt({ lastForeignPromptInputAt: 6_000 }))).toEqual({
      kind: "unavailable",
      reason: "typed",
    });
    expect(h.ended()).toEqual([{ kind: "dropped", reason: "typed" }]);
    expect(h.published.at(-1)?.held).toBeNull();
  });

  it("drops for a restarted run, a closed pane, or a terminal that ended", () => {
    const restarted = setup();
    restarted.request();
    restarted.generations.set(T, 8);
    expect(restarted.wakes[0]!.recheck().kind).toBe("unavailable");
    expect(restarted.ended()).toEqual([{ kind: "dropped", reason: "restarted" }]);

    const incarnation = setup();
    incarnation.request();
    incarnation.wakes[0]!.recheck(atPrompt({ agentIncarnation: 2 }));
    expect(incarnation.ended()).toEqual([{ kind: "dropped", reason: "restarted" }]);

    const trashed = setup();
    trashed.request();
    trashed.wakes[0]!.recheck(atPrompt({ isTrashed: true }));
    expect(trashed.ended()).toEqual([{ kind: "dropped", reason: "closed" }]);

    const gone = setup();
    gone.request();
    gone.projects.delete(T);
    gone.wakes[0]!.recheck();
    expect(gone.ended()).toEqual([{ kind: "dropped", reason: "ended" }]);
  });

  it("expires after its time", () => {
    const h = setup();
    h.request();
    h.advance(COMPOSER_HOLD_TTL_MS);
    expect(h.wakes[0]!.recheck(atPrompt())).toEqual({ kind: "unavailable", reason: "expired" });
    expect(h.ended()).toEqual([{ kind: "dropped", reason: "expired" }]);
  });

  it("can't be withdrawn once on its way, and reports what the host wrote", () => {
    const h = setup();
    const admission = h.request();
    if (!admission.ok) throw new Error("not held");
    const [wake] = h.wakes;
    expect(wake!.beforeType()).toBe(true);
    expect(h.published.at(-1)?.held?.status).toBe("sending");
    expect(h.hold.withdraw(T, admission.send.token, PROJECT)).toBe(false);

    wake!.report({ kind: "delivered" }, { phase: "pty_written", submissionToken: "line-1" });
    expect(h.ended()).toEqual([{ kind: "delivered" }]);
    // The pane is free for its next send.
    expect(h.request("next").ok).toBe(true);
  });

  it("never sends again a line it can't confirm", () => {
    const h = setup();
    h.request();
    const [wake] = h.wakes;
    wake!.beforeType();
    wake!.report({ kind: "ambiguous", reason: "unconfirmed" });
    expect(h.ended()).toEqual([{ kind: "dropped", reason: "unconfirmed" }]);
    expect(wake!.recheck(atPrompt()).kind).toBe("unavailable");
    expect(wake!.beforeType()).toBe(false);
    expect(h.hold.list(PROJECT)).toEqual([]);
    expect(h.request("next").ok).toBe(true);
  });

  it("drops once the screen that held it no longer drives the project", () => {
    const h = setup();
    h.request();
    expect(h.wakes[0]!.recheck(atPrompt())).toEqual({ kind: "ready" });
    h.driving.value = false;
    expect(h.wakes[0]!.recheck(atPrompt())).toEqual({
      kind: "unavailable",
      reason: "driven-elsewhere",
    });
    expect(h.ended()).toEqual([{ kind: "dropped", reason: "driven-elsewhere" }]);
  });

  it("gives a dropped send's text and images to the views, never a delivered one's", () => {
    const dropped = setup();
    dropped.request("held text");
    dropped.hold.endForTerminal(T, "closed");
    expect(dropped.published.at(-1)?.ended).toMatchObject({
      text: "held text",
      imagePaths: ["/tmp/shot.png"],
    });

    const delivered = setup();
    delivered.request("held text");
    delivered.wakes[0]!.beforeType();
    delivered.wakes[0]!.report(
      { kind: "delivered" },
      { phase: "pty_written", submissionToken: "line-1" }
    );
    expect(delivered.published.at(-1)?.ended?.text).toBeUndefined();
  });

  it("withdraws a waiting send for its own project only", () => {
    const h = setup();
    const admission = h.request();
    if (!admission.ok) throw new Error("not held");
    expect(h.hold.withdraw(T, admission.send.token, "other-project")).toBe(false);
    expect(h.hold.withdraw(T, "token-other", PROJECT)).toBe(false);
    expect(h.hold.withdraw(T, admission.send.token, PROJECT)).toBe(true);
    expect(h.ended()).toEqual([{ kind: "withdrawn" }]);
    expect(h.wakes[0]!.recheck().kind).toBe("unavailable");
    expect(h.wakes[0]!.beforeType()).toBe(false);
  });

  it("says a restart or a close dropped it when the pane's lifecycle says so first", () => {
    const h = setup();
    h.request();
    h.hold.endForTerminal(T, "restarted");
    expect(h.ended()).toEqual([{ kind: "dropped", reason: "restarted" }]);
    // The line's own stop afterwards says nothing more.
    h.wakes[0]!.report({ kind: "unavailable", reason: "stopped" });
    expect(h.ended()).toHaveLength(1);
  });

  it("reads the terminal to say why its line stopped taking it", async () => {
    const trashed = setup();
    trashed.request();
    trashed.terminals.set(T, atPrompt({ isTrashed: true }));
    trashed.wakes[0]!.report({ kind: "unavailable", reason: "stopped" });
    await vi.waitFor(() =>
      expect(trashed.ended()).toEqual([{ kind: "dropped", reason: "closed" }])
    );

    const exited = setup();
    exited.request();
    exited.terminals.set(T, null);
    exited.wakes[0]!.report({ kind: "unavailable", reason: "stopped" });
    await vi.waitFor(() => expect(exited.ended()).toEqual([{ kind: "dropped", reason: "ended" }]));

    const stopped = setup();
    stopped.request();
    stopped.terminals.set(T, working());
    stopped.wakes[0]!.report({ kind: "unavailable", reason: "stopped" });
    await vi.waitFor(() =>
      expect(stopped.ended()).toEqual([{ kind: "dropped", reason: "stopped" }])
    );
  });

  it("names the send held since when an earlier one's outcome lands late", async () => {
    const h = setup();
    const first = h.request("first");
    h.wakes[0]!.report({ kind: "unavailable", reason: "stopped" });
    const second = h.request("second");
    if (!first.ok || !second.ok) throw new Error("not held");
    await vi.waitFor(() => expect(h.ended()).toHaveLength(1));
    const last = h.published.at(-1);
    expect(last?.ended?.token).toBe(first.send.token);
    expect(last?.held?.token).toBe(second.send.token);
  });

  it("lets the wake engine go once nothing is held, and takes it again for the next", async () => {
    const h = setup();
    const admission = h.request();
    if (!admission.ok) throw new Error("not held");
    h.hold.withdraw(T, admission.send.token, PROJECT);
    await Promise.resolve();
    expect(h.release).toHaveBeenCalledTimes(1);

    h.request("next");
    expect(h.openWakes).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable when the line refuses it at once, and tells no view", async () => {
    const h = setup();
    h.openWakes.mockReturnValueOnce({
      queueWake: (_pane: unknown, _projectId: string, wake: LaneWake) =>
        wake.report({ kind: "unavailable", reason: "capacity" }),
      release: h.release,
    });
    expect(h.request()).toEqual({ ok: false, reason: "unavailable" });
    // Nothing is left holding the pane once the engine has been let go.
    await Promise.resolve();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.request().ok).toBe(true);
    await vi.waitFor(() => expect(h.published).toHaveLength(1));
    expect(h.ended()).toEqual([]);
  });

  it("lists only its project's waiting sends", () => {
    const h = setup();
    h.request();
    expect(h.hold.list(PROJECT).map((send) => send.text)).toEqual(["fix the tests"]);
    expect(h.hold.list("other-project")).toEqual([]);
  });

  describe("sendNow", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function held(h: ReturnType<typeof setup>, info = working()) {
      const admission = h.request("held text", info);
      if (!admission.ok) throw new Error("not held");
      return admission.send.token;
    }

    it("types it at once, whatever the pane is doing, and once only", async () => {
      vi.useFakeTimers();
      const h = setup();
      h.terminals.set(T, atPrompt({ waitingReason: "question" }));
      const token = held(h);
      const [wake] = h.wakes;

      await expect(h.sendNow(token)).resolves.toEqual({ outcome: "sending" });
      expect(h.submit).toHaveBeenCalledTimes(1);
      const [terminalId, text, submissionToken, imagePaths] = h.submit.mock.calls[0]!;
      expect([terminalId, text, imagePaths]).toEqual([T, "held text", ["/tmp/shot.png"]]);
      expect(submissionToken).not.toBe(token);
      expect(h.published.at(-1)?.held?.status).toBe("sending");

      // The pane's own prompt coming back finds nothing left to type.
      expect(wake!.recheck(atPrompt())).toEqual({ kind: "unavailable", reason: "sent-now" });
      expect(wake!.beforeType()).toBe(false);
      wake!.report({ kind: "unavailable", reason: "sent-now" });
      await expect(h.sendNow(token)).resolves.toEqual({ outcome: "already-sending" });
      expect(h.hold.withdraw(T, token, PROJECT)).toBe(false);
      expect(h.ended()).toEqual([]);

      // Another line's write says nothing of this one.
      h.readTerminal.mockImplementationOnce(async () => ({
        ...atPrompt(),
        submission: { token: "another-line", phase: "pty_written" },
      }));
      await vi.advanceTimersByTimeAsync(100);
      expect(h.ended()).toEqual([]);

      h.submissions.set(submissionToken, "pty_written");
      await vi.advanceTimersByTimeAsync(250);
      expect(h.ended()).toEqual([{ kind: "delivered" }]);
      expect(h.submit).toHaveBeenCalledTimes(1);
      expect(h.request("next").ok).toBe(true);
    });

    it("leaves it to the pane's prompt that took it first", async () => {
      const h = setup();
      const token = held(h);
      expect(h.wakes[0]!.beforeType()).toBe(true);
      await expect(h.sendNow(token)).resolves.toEqual({ outcome: "already-sending" });
      expect(h.submit).not.toHaveBeenCalled();

      // …even when the prompt takes it while Send now reads the terminal.
      const raced = setup();
      const racedToken = held(raced);
      let release!: (info: NotifyTerminalInfo) => void;
      raced.readTerminal.mockImplementationOnce(
        () => new Promise<NotifyTerminalInfo>((resolve) => (release = resolve))
      );
      const answer = raced.sendNow(racedToken);
      expect(raced.wakes[0]!.beforeType()).toBe(true);
      release(working());
      await expect(answer).resolves.toEqual({ outcome: "already-sending" });
      expect(raced.submit).not.toHaveBeenCalled();
      expect(raced.published.at(-1)?.held?.status).toBe("sending");
    });

    it("drops it, saying why, when it can't go", async () => {
      const blocked = setup();
      await expect(blocked.sendNow(held(blocked), { inputBlocked: true })).resolves.toEqual({
        outcome: "dropped",
      });
      expect(blocked.ended()).toEqual([{ kind: "dropped", reason: "input-blocked" }]);
      expect(blocked.published.at(-1)?.ended).toMatchObject({ text: "held text" });

      const driven = setup();
      await driven.sendNow(held(driven), { drives: false, inputBlocked: true });
      expect(driven.ended()).toEqual([{ kind: "dropped", reason: "driven-elsewhere" }]);

      const lostDuringRead = setup();
      let reads = 0;
      await lostDuringRead.sendNow(held(lostDuringRead), { drives: () => ++reads === 1 });
      expect(reads).toBe(2);
      expect(lostDuringRead.ended()).toEqual([{ kind: "dropped", reason: "driven-elsewhere" }]);

      const holderLeft = setup();
      const holderToken = held(holderLeft);
      holderLeft.driving.value = false;
      await holderLeft.sendNow(holderToken);
      expect(holderLeft.ended()).toEqual([{ kind: "dropped", reason: "driven-elsewhere" }]);

      const gone = setup();
      const goneToken = held(gone);
      gone.terminals.set(T, null);
      await gone.sendNow(goneToken);
      expect(gone.ended()).toEqual([{ kind: "dropped", reason: "ended" }]);

      const restarted = setup();
      const restartedToken = held(restarted);
      restarted.terminals.set(T, working({ agentIncarnation: 2 }));
      await restarted.sendNow(restartedToken);
      expect(restarted.ended()).toEqual([{ kind: "dropped", reason: "restarted" }]);

      const typed = setup();
      const typedToken = held(typed, working({ lastForeignPromptInputAt: 900 }));
      typed.terminals.set(T, working({ lastForeignPromptInputAt: 6_000 }));
      await typed.sendNow(typedToken);
      expect(typed.ended()).toEqual([{ kind: "dropped", reason: "typed" }]);

      for (const h of [blocked, driven, lostDuringRead, holderLeft, gone, restarted, typed]) {
        expect(h.submit).not.toHaveBeenCalled();
      }
    });

    it("says why the terminal refused it, and never types again what it can't confirm", async () => {
      vi.useFakeTimers();
      const refused = setup();
      await refused.sendNow(held(refused));
      refused.submissions.set(refused.submit.mock.calls[0]![2], "cancelled");
      await vi.advanceTimersByTimeAsync(100);
      expect(refused.ended()).toEqual([{ kind: "dropped", reason: "input-blocked" }]);

      const exited = setup();
      await exited.sendNow(held(exited));
      exited.terminals.set(T, working({ isExited: true }));
      exited.submissions.set(exited.submit.mock.calls[0]![2], "cancelled");
      await vi.advanceTimersByTimeAsync(100);
      expect(exited.ended()).toEqual([{ kind: "dropped", reason: "ended" }]);

      const failed = setup();
      await failed.sendNow(held(failed));
      failed.submissions.set(failed.submit.mock.calls[0]![2], "failed");
      await vi.advanceTimersByTimeAsync(100);
      expect(failed.ended()).toEqual([{ kind: "dropped", reason: "unconfirmed" }]);

      const lost = setup();
      await lost.sendNow(held(lost));
      lost.submissions.set(lost.submit.mock.calls[0]![2], "unknown");
      await vi.advanceTimersByTimeAsync(100);
      expect(lost.ended()).toEqual([{ kind: "dropped", reason: "unconfirmed" }]);

      const silent = setup();
      await silent.sendNow(held(silent));
      silent.submissions.set(silent.submit.mock.calls[0]![2], "writing");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(silent.ended()).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(silent.ended()).toEqual([{ kind: "dropped", reason: "unconfirmed" }]);

      const threw = setup();
      threw.submit.mockImplementationOnce(() => {
        throw new Error("host gone");
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(threw.sendNow(held(threw))).resolves.toEqual({ outcome: "dropped" });
      expect(threw.ended()).toEqual([{ kind: "dropped", reason: "unconfirmed" }]);

      await vi.advanceTimersByTimeAsync(60_000);
      for (const h of [refused, exited, failed, lost, silent, threw]) {
        expect(h.submit).toHaveBeenCalledTimes(1);
        expect(h.ended()).toHaveLength(1);
        expect(h.wakes[0]!.beforeType()).toBe(false);
      }
    });

    it("touches nothing for another project's send, another token, or one that ended", async () => {
      const h = setup();
      const token = held(h);
      await expect(
        h.hold.sendNow({
          terminalId: T,
          token,
          projectId: "other-project",
          inputBlocked: true,
          authorize: () => true,
        })
      ).resolves.toEqual({ outcome: "not-held" });
      await expect(h.sendNow("token-other", { inputBlocked: true })).resolves.toEqual({
        outcome: "not-held",
      });
      expect(h.ended()).toEqual([]);

      h.hold.withdraw(T, token, PROJECT);
      await expect(h.sendNow(token)).resolves.toEqual({ outcome: "not-held" });
      expect(h.submit).not.toHaveBeenCalled();

      // …nor for one withdrawn while Send now reads the terminal.
      const raced = setup();
      const racedToken = held(raced);
      let release!: (info: NotifyTerminalInfo) => void;
      raced.readTerminal.mockImplementationOnce(
        () => new Promise<NotifyTerminalInfo>((resolve) => (release = resolve))
      );
      const answer = raced.sendNow(racedToken);
      expect(raced.hold.withdraw(T, racedToken, PROJECT)).toBe(true);
      release(working());
      await expect(answer).resolves.toEqual({ outcome: "not-held" });
      expect(raced.submit).not.toHaveBeenCalled();
      expect(raced.ended()).toEqual([{ kind: "withdrawn" }]);
    });

    it("stops following a send typed now once disposed", async () => {
      vi.useFakeTimers();
      const h = setup();
      await h.sendNow(held(h));
      expect(vi.getTimerCount()).toBe(1);
      h.hold.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.ended()).toEqual([{ kind: "dropped", reason: "stopped" }]);
      const reads = h.readTerminal.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.readTerminal.mock.calls.length).toBe(reads);
      expect(h.ended()).toHaveLength(1);
    });
  });
});
