// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

const watch = vi.hoisted(() => ({
  onList: null as ((list: DecisionQuestionList) => void) | null,
  starts: 0,
  stop: vi.fn(),
  throws: false,
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: {
    watchQuestions: (onList: (list: DecisionQuestionList) => void) => {
      if (watch.throws) throw new Error("no bridge");
      watch.starts += 1;
      watch.onList = onList;
      return watch.stop;
    },
  },
}));

import { isWaitingOnPerson, useDecisionsWaitingCount } from "../useDecisionsWaitingCount";

const seen: number[] = [];

function Probe({ active }: { active: boolean }) {
  seen.push(useDecisionsWaitingCount(active));
  return null;
}

function question(standing: DecisionQuestionStanding, index: number): DecisionQuestionListItem {
  return {
    reference: { hostId: "local", projectId: "p1", terminalId: "t1", questionId: `q${index}` },
    alias: index + 1,
    agentKind: "claude",
    projectLabel: "Project",
    worktreeId: "wt",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-18T00:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
  };
}

const list = (revision: number, ...standings: DecisionQuestionStanding[]) =>
  act(() => watch.onList?.({ revision, questions: standings.map(question) }));

beforeEach(() => {
  seen.length = 0;
  watch.onList = null;
  watch.starts = 0;
  watch.stop.mockClear();
  watch.throws = false;
});

afterEach(() => {
  cleanup();
});

describe("isWaitingOnPerson", () => {
  it("takes the inbox's Needs you group: a question still open to an answer", () => {
    const waiting: DecisionQuestionStanding[] = [
      { kind: "waiting", reason: "open" },
      { kind: "waiting", reason: "reply" },
      { kind: "queued" },
    ];
    const not: DecisionQuestionStanding[] = [
      { kind: "to-type" },
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
      { kind: "send-failed" },
      { kind: "settled", outcome: "answered", handled: true },
      { kind: "settled", outcome: "declined" },
    ];
    expect(waiting.map((standing) => isWaitingOnPerson({ standing }))).toEqual([true, true, true]);
    expect(not.some((standing) => isWaitingOnPerson({ standing }))).toBe(false);
  });
});

describe("isWaitingOnPerson, once the person has marked a question (#17895)", () => {
  const open: DecisionQuestionStanding = { kind: "waiting", reason: "open" };
  it("leaves out what they've seen or cleared, and counts it again at a new ask", () => {
    const at = (seen: boolean, cleared: boolean) => ({
      standing: open,
      inbox: { ask: "note-1", seen, cleared },
    });
    expect(isWaitingOnPerson(at(false, false))).toBe(true);
    expect(isWaitingOnPerson(at(true, false))).toBe(false);
    expect(isWaitingOnPerson(at(false, true))).toBe(false);
    // A mark made at an earlier ask: main lists the new ask unmarked.
    expect(
      isWaitingOnPerson({ standing: open, inbox: { ask: "note-2", seen: false, cleared: false } })
    ).toBe(true);
  });

  it("counts what the list leaves unmarked", async () => {
    render(<Probe active />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          { ...question(open, 0), inbox: { ask: null, seen: true, cleared: false } },
          { ...question(open, 1), inbox: { ask: null, seen: false, cleared: true } },
          { ...question({ kind: "queued" }, 2), inbox: { ask: null, seen: false, cleared: false } },
        ],
      })
    );
    expect(seen.at(-1)).toBe(1);
  });
});

describe("useDecisionsWaitingCount", () => {
  it("reads nothing while inactive", () => {
    render(<Probe active={false} />);
    expect(watch.starts).toBe(0);
    expect(seen.at(-1)).toBe(0);
  });

  it("counts the waiting questions in each list it is given", () => {
    render(<Probe active />);
    expect(seen.at(-1)).toBe(0);
    list(1, { kind: "waiting", reason: "open" }, { kind: "queued" }, { kind: "to-type" });
    expect(seen.at(-1)).toBe(2);
    list(2, { kind: "settled", outcome: "answered", handled: false }, { kind: "queued" });
    expect(seen.at(-1)).toBe(1);
  });

  it("shares one watch between its readers and stops it with the last of them", () => {
    const first = render(<Probe active />);
    const second = render(<Probe active />);
    expect(watch.starts).toBe(1);

    first.unmount();
    expect(watch.stop).not.toHaveBeenCalled();
    second.unmount();
    expect(watch.stop).toHaveBeenCalledTimes(1);
  });

  it("forgets the count when nobody watches, so the next reader starts at zero", () => {
    const { unmount } = render(<Probe active />);
    list(1, { kind: "queued" }, { kind: "queued" });
    expect(seen.at(-1)).toBe(2);
    unmount();

    render(<Probe active />);
    expect(seen.at(-1)).toBe(0);
    expect(watch.starts).toBe(2);
  });

  it("stops watching when its reader goes inactive", () => {
    const { rerender } = render(<Probe active />);
    list(1, { kind: "queued" });
    rerender(<Probe active={false} />);
    expect(watch.stop).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(0);
  });

  it("reads zero rather than coming down when the bridge throws", () => {
    watch.throws = true;
    render(<Probe active />);
    expect(seen.at(-1)).toBe(0);
  });
});
