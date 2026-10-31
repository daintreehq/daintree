import { describe, expect, it } from "vitest";
import { JUDGE_SCHEMA, buildJudgePrompt, parseJudgeResponse } from "../turnOutcomeJudge.js";
import { TURN_OUTCOME_CLASS_ORDER } from "../turnOutcomeLib.js";
import type { AssistantTurnRecord } from "../../../shared/types/ipc/mcpServer.js";

function record(id: string): AssistantTurnRecord {
  return { id, timestamp: 1, terminalId: "t1", sessionId: "s1", outcome: "answered" };
}

describe("judge vocabulary", () => {
  it("lets the judge answer with every class, reasoning-loop included", () => {
    const offered = JUDGE_SCHEMA.properties.classifications.items.properties.outcome.enum;
    expect([...offered].sort()).toEqual([...TURN_OUTCOME_CLASS_ORDER].sort());
    expect(offered).toContain("reasoning-loop");
  });

  it("describes every class in the prompt", () => {
    const prompt = buildJudgePrompt([record("r1")]);
    for (const cls of TURN_OUTCOME_CLASS_ORDER) {
      expect(prompt).toMatch(new RegExp(`^- ${cls}: \\S`, "m"));
    }
    expect(prompt).toContain("id: r1");
  });
});

describe("parseJudgeResponse", () => {
  const batch = [record("a"), record("b"), record("c")];

  it("aligns answers to batch order and keeps reasoning-loop", () => {
    const content = JSON.stringify({
      classifications: [
        { id: "c", outcome: "hedged", reasoning: "" },
        { id: "a", outcome: "reasoning-loop", reasoning: "" },
        { id: "b", outcome: "answered", reasoning: "" },
      ],
    });
    expect(parseJudgeResponse(batch, content)).toEqual(["reasoning-loop", "answered", "hedged"]);
  });

  it("marks records the judge skipped or answered outside the vocabulary as unjudged", () => {
    const content = JSON.stringify({
      classifications: [
        { id: "a", outcome: "answered", reasoning: "" },
        { id: "b", outcome: "made-up", reasoning: "" },
        { id: "elsewhere", outcome: "hedged", reasoning: "" },
      ],
    });
    expect(parseJudgeResponse(batch, content)).toEqual(["answered", null, null]);
  });

  it("judges nothing from an empty, malformed or misshapen response", () => {
    for (const content of [undefined, "", "{not json", JSON.stringify({ items: [] }), "null"]) {
      expect(parseJudgeResponse(batch, content)).toEqual([null, null, null]);
    }
  });
});
