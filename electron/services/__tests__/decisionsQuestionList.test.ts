import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionQuestionListItem } from "../../../shared/types/decisionsQuestion.js";

type Source = typeof import("../decisionsQuestionList.js");
let source: Source;

function item(alias: number, kind: "waiting" | "queued" = "waiting"): DecisionQuestionListItem {
  return {
    reference: {
      hostId: "host_1",
      projectId: `project-${alias}`,
      terminalId: "t1",
      questionId: `question_${alias}`,
    },
    alias,
    agentKind: "claude",
    projectLabel: null,
    worktreeId: "w1",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing: kind === "waiting" ? { kind, reason: "open" } : { kind },
    replyRequest: null,
    stall: null,
  };
}

beforeEach(async () => {
  vi.resetModules();
  source = await import("../decisionsQuestionList.js");
});

describe("decisionsQuestionList", () => {
  it("starts empty, as Decisions off is", () => {
    expect(source.getDecisionQuestionList()).toEqual({ revision: 0, questions: [] });
  });

  it("tells listeners each change once, with a higher revision, and nothing for the same list", () => {
    const heard = vi.fn();
    source.onDecisionQuestionsChanged(heard);

    const first = source.setDecisionQuestions([item(1)]);
    expect(first).toEqual({ revision: 1, questions: [item(1)] });
    expect(source.setDecisionQuestions([item(1)])).toBeNull();
    const second = source.setDecisionQuestions([item(1, "queued"), item(2)]);
    const cleared = source.setDecisionQuestions([]);

    expect(heard.mock.calls.map(([list]) => list)).toEqual([first, second, cleared]);
    expect(cleared).toEqual({ revision: 3, questions: [] });
    expect(source.getDecisionQuestionList()).toBe(cleared);
  });

  it("names the Remote Hosts away with the list, as a change of its own (#18022)", () => {
    const heard = vi.fn();
    source.onDecisionQuestionsChanged(heard);
    const rows = [item(1)];
    source.setDecisionQuestions(rows);
    const away = source.setDecisionQuestions(rows, ["Studio"]);
    expect(away).toEqual({ revision: 2, questions: rows, hostsAway: ["Studio"] });
    expect(source.setDecisionQuestions(rows, ["Studio"])).toBeNull();
    // Back: the field goes rather than staying empty.
    const back = source.setDecisionQuestions(rows);
    expect(back).toEqual({ revision: 3, questions: rows });
    expect(back !== null && "hostsAway" in back).toBe(false);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("keeps a copy, so a later change to the array handed in changes nothing", () => {
    const questions = [item(1)];
    source.setDecisionQuestions(questions);
    questions.push(item(2));
    expect(source.getDecisionQuestionList().questions).toEqual([item(1)]);
  });

  it("still tells the other listeners when one throws, and stops telling one that left", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const after = vi.fn();
    const left = vi.fn();
    source.onDecisionQuestionsChanged(() => {
      throw new Error("consumer broke");
    });
    source.onDecisionQuestionsChanged(after);
    const off = source.onDecisionQuestionsChanged(left);
    off();

    expect(source.setDecisionQuestions([item(1)])).not.toBeNull();
    expect(after).toHaveBeenCalledOnce();
    expect(left).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
