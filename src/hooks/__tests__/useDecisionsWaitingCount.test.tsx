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

import { deliveryNeedsPerson, isWaitingOnPerson } from "@shared/utils/decisionWaiting";
import { groupOf } from "@/components/Decisions/decisionsInboxModel";
import {
  useDecisionsStoppedCount,
  useDecisionsWaitingCount,
  usePaneClearedQuestions,
  usePaneClosings,
} from "../useDecisionsWaitingCount";

const seen: number[] = [];

function Probe({ active }: { active: boolean }) {
  seen.push(useDecisionsWaitingCount(active));
  return null;
}

const stoppedSeen: number[] = [];

function StoppedProbe({ active }: { active: boolean }) {
  stoppedSeen.push(useDecisionsStoppedCount(active));
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
  stoppedSeen.length = 0;
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

describe("isWaitingOnPerson against the inbox (#18046)", () => {
  // Keyed by kind so a new standing has to be listed here, and so judged against the inbox.
  const BY_KIND: Record<DecisionQuestionStanding["kind"], DecisionQuestionStanding[]> = {
    waiting: [
      { kind: "waiting", reason: "open" },
      { kind: "waiting", reason: "reply" },
    ],
    queued: [{ kind: "queued" }],
    "send-failed": [{ kind: "send-failed" }],
    "to-type": [{ kind: "to-type" }],
    "needs-attention": [
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
    ],
    settled: [
      { kind: "settled", outcome: "answered", handled: false },
      { kind: "settled", outcome: "answered", handled: true },
      { kind: "settled", outcome: "withdrawn" },
      { kind: "settled", outcome: "expired" },
      { kind: "settled", outcome: "declined" },
    ],
  };

  it("marks exactly the standings the inbox lists under Needs attention as stopped deliveries (#18045)", () => {
    for (const standing of Object.values(BY_KIND).flat()) {
      expect(deliveryNeedsPerson(standing), JSON.stringify(standing)).toBe(
        groupOf(standing) === "attention"
      );
    }
  });

  it("counts exactly the standings the inbox lists under Needs you, as main's title and Dock count does", () => {
    for (const standing of Object.values(BY_KIND).flat()) {
      expect(isWaitingOnPerson({ standing }), JSON.stringify(standing)).toBe(
        groupOf(standing) === "needs-you"
      );
    }
    expect(
      Object.values(BY_KIND)
        .flat()
        .some((standing) => groupOf(standing) === "needs-you")
    ).toBe(true);
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

describe("useDecisionsWaitingCount, as deadlines pass (#17943)", () => {
  const START = Date.parse("2026-11-20T14:00:00.000Z");
  let wake: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    wake = null;
    Reflect.set(window, "electron", {
      systemSleep: {
        onWake: (listener: () => void) => {
          wake = listener;
          return () => {
            wake = null;
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(window, "electron");
  });

  const timed = (index: number, expiresAt: string | null, standing: DecisionQuestionStanding) => ({
    ...question(standing, index),
    expiresAt,
  });

  it("drops an ask from the count as its deadline passes, though the list didn't move", () => {
    render(<Probe active />);
    const soon = new Date(START + 60_000).toISOString();
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          timed(0, soon, { kind: "waiting", reason: "open" }),
          timed(1, null, { kind: "waiting", reason: "open" }),
          // A reply asked for isn't bound by the question's deadline, even a later one.
          timed(2, new Date(START + 5 * 60_000).toISOString(), {
            kind: "waiting",
            reason: "reply",
          }),
        ],
      })
    );
    expect(seen.at(-1)).toBe(3);
    const renders = seen.length;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(seen.length).toBe(renders);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(seen.at(-1)).toBe(2);
    // Nothing left to wait for: the reply's deadline arms nothing.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts again when the machine wakes, though no timer fired while it slept", () => {
    render(<Probe active />);
    const deadline = new Date(START + 10 * 60_000).toISOString();
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [timed(0, deadline, { kind: "queued" })],
      })
    );
    expect(seen.at(-1)).toBe(1);
    vi.setSystemTime(START + 60 * 60_000);
    act(() => {
      wake?.();
    });
    expect(seen.at(-1)).toBe(0);
  });

  it("lets go of its timer and wake listener with its last reader", () => {
    const { unmount } = render(<Probe active />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [timed(0, new Date(START + 60_000).toISOString(), { kind: "queued" })],
      })
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(wake).toBeNull();
  });
});

describe("usePaneClearedQuestions (#18053)", () => {
  const cleared: Array<{ pane: string; ids: string }> = [];

  function Chip({ terminalId, active = true }: { terminalId: string; active?: boolean }) {
    const ids = usePaneClearedQuestions(terminalId, active);
    cleared.push({ pane: terminalId, ids: [...ids].join(",") });
    return null;
  }

  const lastFor = (pane: string) => cleared.filter((entry) => entry.pane === pane).at(-1)?.ids;

  function asked(
    index: number,
    terminalId: string,
    inbox: DecisionQuestionListItem["inbox"],
    over: Partial<DecisionQuestionListItem> = {}
  ): DecisionQuestionListItem {
    const item = question({ kind: "waiting", reason: "open" }, index);
    return { ...item, reference: { ...item.reference, terminalId }, inbox, ...over };
  }

  const clearedAsk = { ask: null, seen: true, cleared: true };
  const seenAsk = { ask: null, seen: true, cleared: false };

  beforeEach(() => {
    cleared.length = 0;
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  });

  it("shares the toolbar's one list watch, and names each pane's cleared questions only", () => {
    render(
      <>
        <Probe active />
        <Chip terminalId="t1" />
        <Chip terminalId="t2" />
      </>
    );
    expect(watch.starts).toBe(1);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          asked(0, "t1", clearedAsk),
          asked(1, "t1", seenAsk),
          { ...asked(4, "t1", clearedAsk), standing: { kind: "queued" } },
          asked(2, "t2", undefined),
          // A request for a reply asks the person too, so its clear steps its row down (#18052).
          { ...asked(3, "t2", clearedAsk), standing: { kind: "waiting", reason: "reply" } },
          { ...asked(5, "t2", seenAsk), standing: { kind: "waiting", reason: "reply" } },
        ],
      })
    );
    expect(lastFor("t1")).toBe("q0,q4");
    expect(lastFor("t2")).toBe("q3");
  });

  it("keeps no clear over a stopped delivery, which can stand over a question still asking something new", () => {
    render(<Chip terminalId="t1" />);
    act(() => watch.onList?.({ revision: 1, questions: [asked(0, "t1", clearedAsk)] }));
    expect(lastFor("t1")).toBe("q0");
    const stopped = {
      ...asked(0, "t1", undefined),
      standing: { kind: "needs-attention" as const, deliveryStatus: "needs-attention" as const },
    };
    act(() => watch.onList?.({ revision: 2, questions: [stopped] }));
    expect(lastFor("t1")).toBe("");
  });

  it("keeps a clear on a question answered since, until it asks again or leaves the list", () => {
    render(<Chip terminalId="t1" />);
    act(() => watch.onList?.({ revision: 1, questions: [asked(0, "t1", clearedAsk)] }));
    expect(lastFor("t1")).toBe("q0");

    // Answered on a phone: the list says so a moment before the pane's state does.
    const answered = { ...asked(0, "t1", undefined), standing: { kind: "to-type" as const } };
    act(() => watch.onList?.({ revision: 2, questions: [answered] }));
    expect(lastFor("t1")).toBe("q0");
    const closed = {
      ...asked(0, "t1", undefined),
      standing: { kind: "settled" as const, outcome: "expired" as const },
    };
    act(() => watch.onList?.({ revision: 3, questions: [closed] }));
    expect(lastFor("t1")).toBe("q0");

    // Asking again, at an ask nobody cleared.
    act(() => watch.onList?.({ revision: 4, questions: [asked(0, "t1", seenAsk)] }));
    expect(lastFor("t1")).toBe("");

    act(() => watch.onList?.({ revision: 5, questions: [asked(0, "t1", clearedAsk)] }));
    act(() => watch.onList?.({ revision: 6, questions: [] }));
    expect(lastFor("t1")).toBe("");
    // Never held over: back in the list, answered, it carries no clear it didn't have.
    act(() => watch.onList?.({ revision: 7, questions: [answered] }));
    expect(lastFor("t1")).toBe("");
  });

  it("tells a pane its question was cleared though the count stays where it was", () => {
    render(
      <>
        <Probe active />
        <Chip terminalId="t1" />
      </>
    );
    act(() => watch.onList?.({ revision: 1, questions: [asked(0, "t1", seenAsk)] }));
    expect(seen.at(-1)).toBe(0);
    expect(lastFor("t1")).toBe("");

    act(() => watch.onList?.({ revision: 2, questions: [asked(0, "t1", clearedAsk)] }));
    expect(seen.at(-1)).toBe(0);
    expect(lastFor("t1")).toBe("q0");

    // Restored, or asking something new: no longer cleared.
    act(() => watch.onList?.({ revision: 3, questions: [asked(0, "t1", seenAsk)] }));
    expect(lastFor("t1")).toBe("");
  });

  it("keeps a Host's cleared question to that Host's window, never a local pane with the same id", () => {
    const host = { hostId: "host-studio", name: "Studio", connected: true };
    render(<Chip terminalId="t1" />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [asked(0, "t1", clearedAsk, { remoteHost: host })],
      })
    );
    expect(lastFor("t1")).toBe("");
    cleanup();

    Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "host-studio" });
    render(<Chip terminalId="t1" />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [asked(0, "t1", clearedAsk, { remoteHost: host }), asked(1, "t1", clearedAsk)],
      })
    );
    expect(lastFor("t1")).toBe("q0");
  });

  it("joins no watch while inactive, and lets the watch go with its last reader", () => {
    const { rerender, unmount } = render(<Chip terminalId="t1" active={false} />);
    expect(watch.starts).toBe(0);
    rerender(<Chip terminalId="t1" />);
    expect(watch.starts).toBe(1);
    act(() => watch.onList?.({ revision: 1, questions: [asked(0, "t1", clearedAsk)] }));
    expect(lastFor("t1")).toBe("q0");
    unmount();
    expect(watch.stop).toHaveBeenCalledTimes(1);

    // The next reader reads afresh rather than a list nobody kept up.
    render(<Chip terminalId="t1" />);
    expect(lastFor("t1")).toBe("");
  });
});

describe("useDecisionsStoppedCount (#18045)", () => {
  const stopped: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "needs-attention",
  };
  const uncertain: DecisionQuestionStanding = {
    kind: "needs-attention",
    deliveryStatus: "delivery-uncertain",
  };

  it("reads nothing while inactive", () => {
    render(<StoppedProbe active={false} />);
    expect(watch.starts).toBe(0);
    expect(stoppedSeen.at(-1)).toBe(0);
  });

  it("counts the deliveries stopped on the person's answers, apart from the questions waiting", () => {
    render(
      <>
        <Probe active />
        <StoppedProbe active />
      </>
    );
    list(1, { kind: "waiting", reason: "open" }, stopped, uncertain, { kind: "to-type" });
    expect(seen.at(-1)).toBe(1);
    expect(stoppedSeen.at(-1)).toBe(2);

    // The person decided what happens to one: it settles and leaves the count.
    list(2, { kind: "waiting", reason: "open" }, uncertain, {
      kind: "settled",
      outcome: "answered",
      handled: true,
    });
    expect(seen.at(-1)).toBe(1);
    expect(stoppedSeen.at(-1)).toBe(1);

    // Nothing left to answer, the delivery still stopped: it stays.
    list(3, uncertain);
    expect(seen.at(-1)).toBe(0);
    expect(stoppedSeen.at(-1)).toBe(1);
  });

  it("lets the last stop go while the question to answer stays", () => {
    render(
      <>
        <Probe active />
        <StoppedProbe active />
      </>
    );
    const ask = question({ kind: "waiting", reason: "open" }, 0);
    const stop = question(stopped, 1);
    act(() => watch.onList?.({ revision: 1, questions: [ask, stop] }));
    expect([seen.at(-1), stoppedSeen.at(-1)]).toEqual([1, 1]);
    const handled: DecisionQuestionStanding = {
      kind: "settled",
      outcome: "answered",
      handled: true,
    };
    act(() => watch.onList?.({ revision: 2, questions: [ask, { ...stop, standing: handled }] }));
    expect([seen.at(-1), stoppedSeen.at(-1)]).toEqual([1, 0]);
  });

  it("waits on no deadline for a stopped delivery alone", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-11-20T14:00:00.000Z"));
      render(<StoppedProbe active />);
      act(() =>
        watch.onList?.({
          revision: 1,
          questions: [{ ...question(stopped, 0), expiresAt: "2026-11-20T15:00:00.000Z" }],
        })
      );
      expect(stoppedSeen.at(-1)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("counts each delivery the stall names: an answer and the person's follow-ups", () => {
    render(<StoppedProbe active />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          {
            ...question(stopped, 0),
            stall: { answerRevision: 0, followUpIds: ["f1", "f2"], reason: "pane_gone" },
          },
          {
            ...question(stopped, 1),
            stall: { answerRevision: null, followUpIds: ["f3"], reason: "pane_gone" },
          },
          // A Host's list from before the detail: one stop all the same.
          {
            ...question(uncertain, 2),
            reference: { hostId: "studio", projectId: "p1", terminalId: "t1", questionId: "h1" },
            remoteHost: { hostId: "studio", name: "Studio", connected: false },
            stall: null,
          },
        ],
      })
    );
    expect(stoppedSeen.at(-1)).toBe(5);
  });

  it("shares the one list watch with the waiting count", () => {
    const { unmount } = render(
      <>
        <Probe active />
        <StoppedProbe active />
      </>
    );
    expect(watch.starts).toBe(1);
    unmount();
    expect(watch.stop).toHaveBeenCalledTimes(1);
  });

  it("forgets the count when nobody watches, so the next reader starts at zero", () => {
    const { unmount } = render(<StoppedProbe active />);
    list(1, stopped);
    expect(stoppedSeen.at(-1)).toBe(1);
    unmount();

    render(<StoppedProbe active />);
    expect(stoppedSeen.at(-1)).toBe(0);
  });

  it("keeps a stopped delivery counted as its question's deadline passes", () => {
    vi.useFakeTimers();
    try {
      const start = Date.parse("2026-11-20T14:00:00.000Z");
      vi.setSystemTime(start);
      render(
        <>
          <Probe active />
          <StoppedProbe active />
        </>
      );
      const soon = new Date(start + 60_000).toISOString();
      act(() =>
        watch.onList?.({
          revision: 1,
          questions: [
            { ...question({ kind: "waiting", reason: "open" }, 0), expiresAt: soon },
            { ...question(stopped, 1), expiresAt: soon },
          ],
        })
      );
      expect([seen.at(-1), stoppedSeen.at(-1)]).toEqual([1, 1]);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect([seen.at(-1), stoppedSeen.at(-1)]).toEqual([0, 1]);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});

describe("usePaneClosings (#18052)", () => {
  const read: Array<{ pane: string; closings: string }> = [];

  function Chip({ terminalId, active = true }: { terminalId: string; active?: boolean }) {
    const closings = usePaneClosings(terminalId, active);
    read.push({
      pane: terminalId,
      closings: [...closings].map(([id, closing]) => `${id}:${closing}`).join(","),
    });
    return null;
  }

  const lastFor = (pane: string) => read.filter((entry) => entry.pane === pane).at(-1)?.closings;

  function closing(
    index: number,
    terminalId: string,
    kind: DecisionQuestionListItem["closing"],
    over: Partial<DecisionQuestionListItem> = {}
  ): DecisionQuestionListItem {
    const item = question({ kind: "waiting", reason: "open" }, index);
    return {
      ...item,
      reference: { ...item.reference, terminalId },
      ...(kind !== undefined ? { closing: kind } : {}),
      ...over,
    };
  }

  beforeEach(() => {
    read.length = 0;
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  });

  it("shares the toolbar's one list watch, and names each pane's own closings", () => {
    render(
      <>
        <Probe active />
        <Chip terminalId="t1" />
        <Chip terminalId="t2" />
      </>
    );
    expect(watch.starts).toBe(1);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          closing(0, "t1", "withdrawing"),
          closing(1, "t1", undefined),
          closing(2, "t1", "declining"),
          closing(3, "t2", undefined),
        ],
      })
    );
    expect(lastFor("t1")).toBe("q0:withdrawing,q2:declining");
    expect(lastFor("t2")).toBe("");
  });

  it("tells a pane only when its closings change, and lets one go once the list does", () => {
    render(<Chip terminalId="t1" />);
    act(() => watch.onList?.({ revision: 1, questions: [closing(0, "t1", "declining")] }));
    const renders = read.length;
    act(() =>
      watch.onList?.({
        revision: 2,
        questions: [closing(0, "t1", "declining"), closing(1, "t1", undefined)],
      })
    );
    expect(read.length).toBe(renders);

    act(() => watch.onList?.({ revision: 3, questions: [closing(0, "t1", undefined)] }));
    expect(lastFor("t1")).toBe("");
  });

  it("keeps a Host's question to that Host's window, never a local pane with the same id", () => {
    const host = { hostId: "host-studio", name: "Studio", connected: true };
    render(<Chip terminalId="t1" />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [closing(0, "t1", "declining", { remoteHost: host })],
      })
    );
    expect(lastFor("t1")).toBe("");
    cleanup();

    Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "host-studio" });
    render(<Chip terminalId="t1" />);
    act(() =>
      watch.onList?.({
        revision: 1,
        questions: [
          closing(0, "t1", "declining", { remoteHost: host }),
          closing(1, "t1", "withdrawing"),
        ],
      })
    );
    expect(lastFor("t1")).toBe("q0:declining");
  });

  it("joins no watch while inactive, and reads afresh after the last reader goes", () => {
    const { rerender, unmount } = render(<Chip terminalId="t1" active={false} />);
    expect(watch.starts).toBe(0);
    rerender(<Chip terminalId="t1" />);
    expect(watch.starts).toBe(1);
    act(() => watch.onList?.({ revision: 1, questions: [closing(0, "t1", "withdrawing")] }));
    expect(lastFor("t1")).toBe("q0:withdrawing");
    unmount();
    expect(watch.stop).toHaveBeenCalledTimes(1);

    render(<Chip terminalId="t1" />);
    expect(lastFor("t1")).toBe("");
  });
});
