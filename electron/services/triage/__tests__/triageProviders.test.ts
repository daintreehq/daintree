import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyScreen,
  combinePriority,
  describeScreen,
  type TriageScreenInput,
} from "../triageProviders.js";

const INPUT: TriageScreenInput = {
  agent: "claude",
  title: "Claude",
  screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
  lines: ["Do you want to proceed?", "❯ 1. Yes", "  2. No"],
  observed: { agentState: "waiting", waitingReason: "approval", secondsInState: 30 },
};

function respondWith(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("combinePriority", () => {
  it("averages the classifier's probability with the describer's score", () => {
    expect(combinePriority(0.9, 30)).toBe(60);
    expect(combinePriority(0.2, 100)).toBe(60);
  });

  it("takes the classifier's word alone for a run that was never described", () => {
    expect(combinePriority(0.42, null)).toBe(42);
  });
});

describe("classifyScreen", () => {
  it("asks for a needs-attention probability and reads it back", async () => {
    const fetchMock = respondWith({
      answers: {
        category: { choice: "approval", confidence: 0.97 },
        needs_attention: { type: "noul", noul: 0.93 },
        question_line: { choice: "line_0" },
      },
    });
    const result = await classifyScreen("key", INPUT);
    expect(result).toMatchObject({ category: "approval", attention: 0.93 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      questions: Record<string, { type: string }>;
    };
    expect(body.questions.needs_attention.type).toBe("noul");
  });

  it("treats a missing or out-of-range probability as no claim on the user", async () => {
    respondWith({ answers: { category: { choice: "idle", confidence: 0.9 } } });
    expect((await classifyScreen("key", INPUT)).attention).toBe(0);
    respondWith({
      answers: { category: { choice: "idle", confidence: 0.9 }, needs_attention: { noul: 7 } },
    });
    expect((await classifyScreen("key", INPUT)).attention).toBe(1);
  });
});

describe("describeScreen", () => {
  function card(score: unknown) {
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              category: "approval",
              headline: "Run the tests?",
              question: "Do you want to proceed?",
              options: ["Yes", "No"],
              summary: "Waiting to run npm test.",
              attention_score: score,
            }),
          },
        },
      ],
    };
  }

  it("reads the attention score, clamped to 0-100", async () => {
    respondWith(card(88));
    expect((await describeScreen("key", "gpt-oss-120b", INPUT, "approval")).attentionScore).toBe(
      88
    );
    respondWith(card(140));
    expect((await describeScreen("key", "gpt-oss-120b", INPUT, "approval")).attentionScore).toBe(
      100
    );
    respondWith(card("high"));
    expect((await describeScreen("key", "gpt-oss-120b", INPUT, "approval")).attentionScore).toBe(0);
  });
});
