import { describe, expect, it } from "vitest";
import { LinkHistory, MAX_LINK_HISTORY_TEXT, historyText } from "../linkHistory.js";

const started = (at: number, clientId = "a") => ({
  kind: "session-started" as const,
  at,
  clientId,
  clientName: "greg-mbp",
  sessionId: `s-${at}`,
  previousNotResumed: null,
});

const refusal = (at: number, clientId = "a", reason: "busy" | "unauthorized" = "busy") => ({
  at,
  clientId,
  clientName: "greg-mbp",
  reason,
  detail: null,
});

describe("LinkHistory", () => {
  it("lists newest first and lets the oldest go past its bound, saying so", () => {
    const history = new LinkHistory(3);
    for (let at = 1; at <= 3; at++) history.record(started(at));
    expect(history.list()).toEqual({
      events: [started(3), started(2), started(1)],
      truncated: false,
    });
    history.record(started(4));
    expect(history.list().events.map((event) => event.at)).toEqual([4, 3, 2]);
    expect(history.list().truncated).toBe(true);
  });

  it("hands out copies, so a reader can't change what it keeps", () => {
    const history = new LinkHistory();
    history.refused(refusal(1), false);
    const listed = history.list().events[0]!;
    if (listed.kind === "refused") listed.count = 99;
    expect(history.list().events[0]).toMatchObject({ count: 1 });
  });

  it("counts a repeated refusal on the launch's last entry, with when it last happened", () => {
    const history = new LinkHistory();
    history.refused(refusal(1), false);
    history.record(started(2, "b"));
    history.refused(refusal(3), true);
    history.refused(refusal(4), true);
    expect(history.list().events).toEqual([
      started(2, "b"),
      { ...refusal(1), kind: "refused", count: 3, lastAt: 4 },
    ]);
  });

  it("starts a new entry for a different refusal, or once the launch got in since", () => {
    const history = new LinkHistory();
    history.refused(refusal(1), false);
    history.refused(refusal(2, "a", "unauthorized"), true);
    history.record(started(3));
    history.refused(refusal(4, "a", "unauthorized"), true);
    expect(history.list().events.map((event) => [event.kind, event.at])).toEqual([
      ["refused", 4],
      ["session-started", 3],
      ["refused", 2],
      ["refused", 1],
    ]);
  });

  it("cuts text from the other side to what a person reads", () => {
    expect(historyText("socket closed")).toBe("socket closed");
    expect(historyText("x".repeat(MAX_LINK_HISTORY_TEXT + 10))).toHaveLength(MAX_LINK_HISTORY_TEXT);
  });
});
