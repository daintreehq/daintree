import { describe, expect, it } from "vitest";
import type { DeclinePhase } from "@/store/decisionsAnswerStore";
import {
  cancelBody,
  cancelProblem,
  cancelTitle,
  dismissBody,
  dismissFallback,
  dismissOutcomeText,
  dismissProgressText,
  dismissTitle,
  dismissVerdict,
  hostAwayNote,
  noLongerWaiting,
  type DecisionCancelTarget,
} from "../decisionCancelModel";

const TARGET: DecisionCancelTarget = {
  question: { scope: "pane", terminalId: "t1", questionId: "q42" },
  label: "q-42",
  line: "Ship the migration?",
  revision: null,
};
const OTHER: DecisionCancelTarget = {
  ...TARGET,
  question: { scope: "pane", terminalId: "t1", questionId: "q7" },
  label: "q-7",
};

function settled(outcome: Extract<DeclinePhase, { kind: "settled" }>["outcome"]): DeclinePhase {
  return { kind: "settled", outcome };
}

/** How many sentences `text` holds, by its ends. */
function sentences(text: string): number {
  return text.match(/[.?!](\s|$)/g)?.length ?? 0;
}

describe("decisionCancelModel", () => {
  it("asks about the question it names, as a decline or, separately, a withdrawal", () => {
    expect(dismissTitle(TARGET)).toBe("Decline question q-42?");
    expect(dismissTitle(OTHER)).toBe("Decline question q-7?");
    expect(cancelTitle(TARGET)).toBe("Withdraw question q-42?");
    expect(cancelTitle(OTHER)).toBe("Withdraw question q-7?");
  });

  it("says in one plain sentence that a decline reaches your phones and a listening agent (#17239, #18041)", () => {
    const body = dismissBody({ ...TARGET, replyMode: "blocking" });
    // Said as what happens once the relay takes it: a queued or refused one says so on its own.
    expect(body).toMatch(/^Once the relay takes it, your phones show it declined/);
    expect(body).toMatch(/an agent still listening is told you chose not to answer/);
    expect(body).toMatch(/nothing is approved\.$/);
    expect(sentences(body)).toBe(1);
    // Named as what it is, never by the phone's label or against Clear, and never as leaving
    // Needs you, which a question already set aside there has left (#18053).
    expect(body).not.toMatch(/dismiss|clear|needs you/i);
  });

  it("says a decline doesn't let an advisory round's plan go ahead, in the same sentence (#17943)", () => {
    const advisory = dismissBody({ ...TARGET, replyMode: "advisory" });
    const blocking = dismissBody({ ...TARGET, replyMode: "blocking" });
    const away = dismissBody({ ...TARGET, lastReadAt: 1 });
    // Its own subject, so it holds whether or not an agent is still there to be told.
    expect(advisory).toMatch(
      /; nothing is approved, and declining doesn't let the agent go ahead with any plan it stated\.$/
    );
    expect(blocking).not.toMatch(/plan/);
    // A mode not read for the revision being signed (a row's Decline) never leaves it out.
    expect(dismissBody({ ...TARGET, replyMode: null })).toBe(advisory);
    expect(dismissBody(TARGET)).toBe(advisory);
    expect(away).toMatch(/declining doesn't let the agent go ahead with any plan it stated\.$/);
    for (const body of [advisory, blocking, away]) {
      expect(sentences(body)).toBe(1);
      expect(body).not.toMatch(/needs you|clear/i);
    }
  });

  it("never promises typing into the terminal for a withdrawal, and waits on the relay only for a question it has", () => {
    for (const queued of [false, true]) {
      const body = cancelBody(queued);
      expect(body).toMatch(/Nothing is typed into this terminal/);
      expect(body).toMatch(/agent sees the question withdrawn/);
    }
    expect(cancelBody(false)).toMatch(/once the relay confirms/);
    expect(cancelBody(true)).toMatch(/hasn't been sent/);
    expect(cancelBody(true)).not.toMatch(/relay confirms/);
  });

  it("reports no problem once main has withdrawn it or committed the withdrawal", () => {
    expect(cancelProblem(TARGET, { result: "cancelled" })).toBeNull();
    expect(cancelProblem(TARGET, { result: "cancelling" })).toBeNull();
  });

  it("says why each withdrawal refusal happened, about the question asked, with only a way out", () => {
    const cases = [
      ["answered", /^q-7 has been answered/],
      ["expired", /^q-7 has expired/],
      ["publish-failed", /^q-7 never reached the relay/],
      ["not-found", /^q-7 is no longer one of this terminal's questions/],
    ] as const;
    for (const [reason, message] of cases) {
      expect(cancelProblem(OTHER, { result: "refused", reason })).toEqual({
        severity: "info",
        message: expect.stringMatching(message),
        retry: false,
      });
    }
  });

  it("lets a question be tried again only when Decisions could still take it", () => {
    expect(cancelProblem(TARGET, { result: "not-running" })).toMatchObject({
      severity: "warning",
      retry: true,
    });
    expect(cancelProblem(TARGET, { result: "off" })).toMatchObject({
      severity: "info",
      retry: false,
    });
    // A Remote Host's question whose Host went away (#17230): it may or may not have been withdrawn.
    expect(cancelProblem(TARGET, { result: "host-not-connected" })).toMatchObject({
      severity: "warning",
      message: expect.stringMatching(/may not have been withdrawn/),
      retry: true,
    });
    expect(noLongerWaiting(OTHER)).toEqual({
      severity: "info",
      message: expect.stringMatching(/^q-7 isn't waiting for an answer any more/),
      retry: false,
    });
    expect(noLongerWaiting(OTHER, "dismiss").message).toMatch(/nothing to decline/);
  });

  describe("a dismissal's outcome (#17239)", () => {
    it("is done once the relay took it or it's queued, under the key it's kept by", () => {
      for (const phase of [settled({ status: "declined" }), settled({ status: "queued" })]) {
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase })).toEqual({
          kind: "done",
          key: "k",
        });
      }
    });

    it("offers withdrawing, saying why, only where a dismissal can't be taken", () => {
      const fallbacks: Array<[DeclinePhase, RegExp]> = [
        [settled({ status: "unsupported", by: "relay" }), /^Your relay needs an update/],
        [
          settled({ status: "unsupported", by: "asking-desktop" }),
          /^Daintree on the computer that asked q-42 needs an update/,
        ],
        [settled({ status: "closed", reason: "not-found" }), /^The relay doesn't hold q-42 yet/],
        [{ kind: "refused", reason: "not-owner" }, /^This computer doesn't sign for you/],
      ];
      for (const [phase, reason] of fallbacks) {
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase })).toEqual({
          kind: "withdraw",
          message: expect.stringMatching(reason),
        });
        expect(dismissFallback("q-42", phase)).toMatch(reason);
      }
      // Anything else isn't a reason to withdraw instead, and says what it is.
      const problems: Array<[DeclinePhase, RegExp, boolean]> = [
        [settled({ status: "already-answered" }), /^q-42 was answered first/, false],
        [settled({ status: "closed", reason: "expired" }), /^q-42 expired first/, false],
        [settled({ status: "closed", reason: "cancelled" }), /withdrawn or declined first/, false],
        [
          settled({ status: "rejected", code: "conflict" }),
          /refused the decline for q-42 \(conflict\)/,
          true,
        ],
        [
          { kind: "refused", reason: "not-found" },
          /no longer one of this terminal's questions/,
          false,
        ],
        [{ kind: "refused", reason: "invalid" }, /couldn't sign the decline for q-42/, true],
        [{ kind: "lost" }, /^Couldn't confirm whether q-42 was declined/, true],
      ];
      for (const [phase, message, retry] of problems) {
        expect(dismissFallback("q-42", phase)).toBeNull();
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase })).toEqual({
          kind: "problem",
          problem: expect.objectContaining({ message: expect.stringMatching(message), retry }),
        });
      }
    });

    it("stops offering withdrawal for a question the relay didn't hold once it reads as sent", () => {
      const notHeld = settled({ status: "closed", reason: "not-found" });
      expect(dismissFallback("q-42", notHeld, "queued")).toMatch(/^The relay doesn't hold q-42/);
      expect(dismissFallback("q-42", notHeld, "open")).toBeNull();
      // A relay or computer that needs updating stays a reason whatever the question reads as.
      expect(
        dismissFallback("q-42", settled({ status: "unsupported", by: "relay" }), "open")
      ).toMatch(/^Your relay needs an update/);
    });

    it("says why one that settled out of the dialog wasn't taken, and nothing while it's under way or taken", () => {
      expect(
        dismissOutcomeText({ ...TARGET, revision: 2 }, settled({ status: "changed" }))
      ).toMatch(/Review it, then decline it again/);
      expect(dismissOutcomeText(TARGET, settled({ status: "declined" }))).toBeNull();
      expect(dismissOutcomeText(TARGET, settled({ status: "queued" }))).toBeNull();
      expect(dismissOutcomeText(TARGET, { kind: "lost" })).toBeNull();
      expect(
        dismissOutcomeText(TARGET, settled({ status: "unsupported", by: "relay" }))
      ).toBeNull();
    });

    it("lets a changed question be declined again from a row, but sends the view's reader back to review it", () => {
      const fromRow = dismissVerdict(TARGET, { kind: "changed" });
      const fromView = dismissVerdict({ ...TARGET, revision: 4 }, { kind: "changed" });
      // Never worded as though it went through.
      expect(fromRow).toMatchObject({
        kind: "problem",
        problem: { retry: true, message: expect.stringMatching(/changed, so it wasn't declined/) },
      });
      expect(fromView).toMatchObject({
        kind: "problem",
        problem: { retry: false, message: expect.stringMatching(/Review it/) },
      });
    });

    it("lets one whose standing is unknown, or that couldn't be read, be tried again", () => {
      expect(
        dismissVerdict(TARGET, { kind: "submitted", key: "k", phase: { kind: "lost" } })
      ).toMatchObject({
        kind: "problem",
        problem: { severity: "warning", retry: true },
      });
      expect(dismissVerdict(TARGET, { kind: "failed", reason: "not-running" })).toMatchObject({
        kind: "problem",
        problem: { retry: true },
      });
      expect(dismissVerdict(TARGET, { kind: "failed", reason: "off" })).toMatchObject({
        kind: "problem",
        problem: { retry: false },
      });
      expect(
        dismissVerdict(TARGET, { kind: "failed", reason: "host-not-connected" })
      ).toMatchObject({
        kind: "problem",
        problem: {
          retry: true,
          message: expect.stringMatching(/^The Remote Host that asked q-42 isn't connected/),
        },
      });
      expect(dismissVerdict(TARGET, { kind: "gone" })).toMatchObject({
        kind: "problem",
        problem: { message: expect.stringMatching(/nothing to decline/) },
      });
    });

    it("says how far one under way has got, and nothing for one that settled otherwise", () => {
      expect(dismissProgressText(settled({ status: "queued" }))).toMatch(/queued/);
      expect(dismissProgressText({ kind: "lost" })).toMatch(/^Couldn't confirm/);
      expect(dismissProgressText(settled({ status: "declined" }))).toMatch(/^Declined/);
      expect(dismissProgressText(settled({ status: "unsupported", by: "relay" }))).toBeNull();
      expect(dismissProgressText({ kind: "refused", reason: "not-owner" })).toBeNull();
    });
  });

  it("calls the action Decline in everything it says of one, and a withdrawal never cancelling (#18041)", () => {
    const outcomes: Array<Extract<DeclinePhase, { kind: "settled" }>["outcome"]> = [
      { status: "queued" },
      { status: "declined" },
      { status: "already-answered" },
      { status: "changed" },
      { status: "closed", reason: "expired" },
      { status: "closed", reason: "cancelled" },
      { status: "closed", reason: "not-found" },
      { status: "unsupported", by: "relay" },
      { status: "unsupported", by: "asking-desktop" },
      { status: "rejected", code: "conflict" },
    ];
    const phases: DeclinePhase[] = [
      { kind: "sending" },
      { kind: "checking" },
      { kind: "lost" },
      ...(["not-found", "not-owner", "invalid", "off"] as const).map((reason): DeclinePhase => ({
        kind: "refused",
        reason,
      })),
      ...outcomes.map(settled),
    ];
    const said: string[] = [dismissTitle(TARGET), dismissBody(), cancelTitle(TARGET)];
    for (const queued of [false, true]) said.push(cancelBody(queued));
    for (const mode of ["dismiss", "withdraw"] as const) {
      said.push(noLongerWaiting(TARGET, mode).message);
    }
    for (const target of [TARGET, { ...TARGET, revision: 2 }, { ...TARGET, lastReadAt: 1 }]) {
      for (const phase of phases) {
        for (const away of [false, true]) said.push(dismissProgressText(phase, away) ?? "");
        said.push(dismissFallback(target.label, phase) ?? "");
        const verdict = dismissVerdict(target, { kind: "submitted", key: "k", phase });
        if (verdict.kind === "withdraw") said.push(verdict.message);
        if (verdict.kind === "problem") said.push(verdict.problem.message);
      }
      for (const attempt of [
        { kind: "gone" },
        { kind: "changed" },
        { kind: "busy" },
        ...(["not-running", "unreadable", "failed", "off", "host-not-connected"] as const).map(
          (reason) => ({ kind: "failed", reason }) as const
        ),
      ] as const) {
        const verdict = dismissVerdict(target, attempt);
        if (verdict.kind === "problem") said.push(verdict.problem.message);
      }
    }
    for (const result of ["off", "not-running", "host-not-connected"] as const) {
      said.push(cancelProblem(TARGET, { result })?.message ?? "");
    }
    for (const reason of ["answered", "expired", "publish-failed", "not-found"] as const) {
      said.push(cancelProblem(TARGET, { result: "refused", reason })?.message ?? "");
    }
    for (const text of said) {
      expect(text).not.toMatch(/dismiss/i);
      expect(text).not.toMatch(/cancel/i);
    }
    expect(said.filter((text) => /declin/i.test(text)).length).toBeGreaterThan(20);
  });

  describe("a dismissal of a Remote Host's question while its Host is away (#17946)", () => {
    const AWAY: DecisionCancelTarget = {
      ...TARGET,
      question: {
        scope: "reference",
        reference: { hostId: "qhost_studio", projectId: "p1", terminalId: "t1", questionId: "q42" },
      },
      revision: 3,
      lastReadAt: 1_000,
    };

    it("says it goes by what was last read here, and the agent hears once the Host is back", () => {
      const body = dismissBody(AWAY);
      expect(body).toMatch(/^If it hasn't changed since this computer last read it/);
      expect(body).toMatch(/your phones show it declined once the relay takes it/);
      expect(body).toMatch(/an agent still listening is told/);
      expect(body).toMatch(/told you chose not to answer when its Remote Host is back/);
      expect(sentences(body)).toBe(1);
      expect(dismissBody({ ...AWAY, lastReadAt: null })).toBe(dismissBody());
    });

    it("never offers withdrawing in its place, and says plainly why it wasn't taken", () => {
      const notTaken: Array<[DeclinePhase, RegExp]> = [
        [settled({ status: "unsupported", by: "relay" }), /^Your relay needs an update/],
        [
          settled({ status: "unsupported", by: "asking-desktop" }),
          /^Daintree on the computer that asked q-42 needs an update/,
        ],
        [settled({ status: "closed", reason: "not-found" }), /^The relay doesn't hold q-42,/],
        [{ kind: "refused", reason: "not-owner" }, /^This computer doesn't sign for you/],
        [settled({ status: "already-answered" }), /^q-42 was answered first/],
        [settled({ status: "closed", reason: "expired" }), /^q-42 expired first/],
      ];
      for (const [phase, message] of notTaken) {
        expect(dismissFallback("q-42", phase, "open", false)).toBeNull();
        const verdict = dismissVerdict(AWAY, { kind: "submitted", key: "k", phase });
        expect(verdict).toEqual({
          kind: "problem",
          problem: expect.objectContaining({ message: expect.stringMatching(message) }),
        });
        expect(JSON.stringify(verdict)).not.toMatch(/withdraw it instead/);
      }
    });

    it("sends a changed one back for review once the Host is back, never to dismiss again now", () => {
      for (const attempt of [
        { kind: "changed" } as const,
        { kind: "submitted", key: "k", phase: settled({ status: "changed" }) } as const,
      ]) {
        expect(dismissVerdict(AWAY, attempt)).toEqual({
          kind: "problem",
          problem: {
            severity: "info",
            message: expect.stringMatching(
              /changed after this computer last read it.*Host is back/
            ),
            retry: false,
          },
        });
      }
    });

    it("says it closes here only once the Host is back, after the relay took it", () => {
      expect(dismissProgressText(settled({ status: "declined" }), true)).toMatch(
        /^Declined\. It closes here once its Remote Host is back/
      );
      expect(dismissProgressText(settled({ status: "queued" }), true)).toBe(
        dismissProgressText(settled({ status: "queued" }))
      );
    });

    it("says beside the Host being away whether it can still be dismissed, and why not", () => {
      const now = 10 * 60_000;
      expect(
        hostAwayNote({ result: "read", revision: 3, alias: 42, readAt: now - 5 * 60_000 }, now)
      ).toMatch(/last read it 5 minutes ago, so you can still decline it/);
      expect(hostAwayNote({ result: "not-sent" }, now)).toMatch(
        /hadn't reached the relay.*can't be declined until the Host is back/
      );
      expect(hostAwayNote({ result: "not-read" }, now)).toMatch(
        /can't be declined until the Host is back/
      );
      expect(hostAwayNote(undefined, now)).toBeNull();
    });
  });
});
