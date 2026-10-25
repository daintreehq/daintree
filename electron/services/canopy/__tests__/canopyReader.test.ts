import { describe, expect, it } from "vitest";
import {
  chooseWeightsFile,
  decodeReading,
  displayText,
  encodeScreen,
  isReaderMeta,
  lineCandidates,
  readerCard,
  type ReaderMeta,
  type ReaderTokenizer,
  type Reading,
} from "../canopyReader.js";

const META: ReaderMeta = {
  max_len: 40,
  header_tokens: 6,
  line_tokens: 8,
  question_candidate_rows: 2,
  status_candidate_rows: 3,
  inputs: ["input_ids", "attention_mask", "line_pos", "line_mask", "q_mask", "s_mask"],
  outputs: [
    "category",
    "needs_attention",
    "blocked_on_user",
    "notable",
    "tests",
    "changes",
    "risk",
    "instruction",
    "progress",
    "failure_repeats",
    "score",
    "question_line",
    "status_line",
    "key_lines",
    "summary_lines",
    "option_lines",
    "action_line",
    "task_line",
  ],
  categories: ["approval", "question", "finished", "error", "working", "running", "idle"],
  classes: {
    tests: ["passing", "failing", "not_run", "unknown"],
    changes: ["uncommitted", "committed", "pushed", "none", "unknown"],
    risk: ["none", "caution", "unknown"],
    instruction: ["none", "asked", "ongoing", "done", "irreversible"],
    progress: ["none", "0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"],
    failure_repeats: ["0", "1", "2", "3+"],
    score: ["98", "94", "92", "86", "75", "70", "65", "55", "40", "20", "5"],
  },
  thresholds: {
    summary_first: 0.5,
    summary_more: 0.6,
    option: 0.5,
    gate: 0.4,
    gate_categories: ["approval", "question", "finished", "error"],
  },
};

/** One token per character, so a test can count a piece's length by eye. */
const CHAR_TOKENS: ReaderTokenizer = {
  ids: (text) => [...text].map((c) => c.codePointAt(0)!),
  tokenId: (token) => ({ "[CLS]": 1, "[SEP]": 2, "[PAD]": 0 })[token] ?? 3,
};

const logit = (p: number) => Math.log(p / (1 - p));

/** Outputs that pick nothing and read idle, with what a test sets laid over them. */
function outputs(lines: number, over: Record<string, number[]> = {}) {
  const base: Record<string, number[]> = {
    category: [0, 0, 0, 0, 0, 0, 5],
    needs_attention: [logit(0.01)],
    blocked_on_user: [logit(0.2)],
    notable: [logit(0.3)],
    question_line: [...Array(lines).fill(0), 5],
    status_line: [...Array(lines).fill(0), 5],
    action_line: [...Array(lines).fill(0), 5],
    task_line: [...Array(lines).fill(0), 5],
    summary_lines: Array(lines).fill(-5),
    option_lines: Array(lines).fill(-5),
    tests: [0, 0, 0, 5],
    changes: [0, 0, 0, 0, 5],
    risk: [0, 0, 5],
    instruction: [5, 0, 0, 0, 0],
    progress: [5, ...Array(11).fill(0)],
    failure_repeats: [5, 0, 0, 0],
    score: [...Array(10).fill(0), 5],
  };
  const all = { ...base, ...over };
  return (name: string) => all[name]!;
}

describe("canopyReader", () => {
  it("fills lines from the bottom of the screen up, and stops at the first that doesn't fit", () => {
    const lines = ["first line here", "", "second", "third line", "last"];
    const e = encodeScreen(META, CHAR_TOKENS, { agent_program: "claude" }, lines);
    // The header is cut to 6 tokens, then [SEP]; every piece is "[i] line\n" cut to 8.
    expect(e.ids.slice(0, 8)).toEqual([1, ...CHAR_TOKENS.ids('{"agent').slice(0, 6), 2]);
    // Budget 40 - 6 - 3 = 31: "last" (8), "third" (8), "second" (8) fit; line 0 does not.
    expect(e.lineIndex).toEqual([2, 3, 4]);
    // Each line head reads the first token of its piece, in screen order.
    expect(e.linePos).toEqual([8, 16, 24]);
    expect(e.ids.at(-1)).toBe(2);
    // The blank line is skipped, never encoded.
    expect(e.lineIndex).not.toContain(1);
    // Question candidates are the bottom two rows, status the bottom three, each
    // over three characters: line 2 is a status candidate only.
    expect(e.qMask).toEqual([false, true, true]);
    expect(e.sMask).toEqual([true, true, true]);
  });

  it("marks the bottom rows with more than three characters as question and status candidates", () => {
    const lines = ["a long first line", "ok", "a question?", "1. Yes"];
    expect(lineCandidates(lines, 2)).toEqual([2, 3]);
    // "ok" is in the bottom three but too short to be asked.
    expect(lineCandidates(lines, 3)).toEqual([2, 3]);
    expect(lineCandidates(lines, 4)).toEqual([0, 2, 3]);
    // Python's whitespace, not JavaScript's: \x1c counts as space and is stripped.
    expect(lineCandidates(["\x1c abc \x1c", "abcd"], 2)).toEqual([1]);
  });

  it("gates attention on the stopped categories as well as its own head, rescaled so 0.4 reads 0.5", () => {
    const idx = [0, 1];
    const at = (needs: number, category: number[]) =>
      decodeReading(META, outputs(2, { needs_attention: [logit(needs)], category }), idx, [
        true,
        true,
      ]).needs_attention;
    // Idle, and the head says no: well under.
    expect(at(0.1, [0, 0, 0, 0, 0, 0, 9])).toBeCloseTo(0.125, 2);
    // The head alone at the gate reads exactly 0.5.
    expect(at(0.4, [0, 0, 0, 0, 0, 0, 9])).toBeCloseTo(0.5, 5);
    // An approval needs the user whatever the head says.
    expect(at(0.01, [9, 0, 0, 0, 0, 0, 0])).toBeGreaterThan(0.99);
  });

  it("picks a line or none, and summary lines while they clear their thresholds, most likely first", () => {
    const idx = [3, 5, 7];
    const reading = decodeReading(
      META,
      outputs(3, {
        status_line: [0, 9, 0, 1],
        question_line: [0, 0, 0, 9],
        summary_lines: [logit(0.55), logit(0.7), logit(0.9)],
        option_lines: [logit(0.9), logit(0.9), logit(0.1)],
      }),
      idx,
      [false, true, true]
    );
    expect(reading.status_line).toBe(5);
    expect(reading.question_line).toBe(-1);
    // 0.9 first, then 0.7 (over 0.6); 0.55 is under the bar for a second line.
    expect(reading.summary_lines).toEqual([7, 5]);
    // Options only from the bottom rows.
    expect(reading.option_lines).toEqual([5]);
    expect(reading.score).toBe("5");
    expect(reading.progress).toBe("none");
  });

  it("strips glyphs, borders and timers off a line, keeping a glyph that is part of a word", () => {
    expect(displayText("⏺ Fixed the rounding.")).toBe("Fixed the rounding.");
    expect(displayText("│ Do you want to proceed?            │")).toBe("Do you want to proceed?");
    expect(displayText("✻ Testing… (12s · esc to interrupt)")).toBe("Testing…");
    expect(displayText("**bold** stays")).toBe("**bold** stays");
    expect(displayText(">file.ts")).toBe(">file.ts");
    expect(displayText("⏺")).toBeNull();
  });

  it("joins a sentence the agent wrapped, but never into a new bullet", () => {
    const lines = [
      "⏺ Fixed the rounding: amounts are",
      "  scaled before they are rounded.",
      "⏺ All 14 tests pass",
      "⏺ Not committed.",
    ];
    const reading = {
      category: "finished",
      status_line: 0,
      summary_lines: [2, 3],
      question_line: -1,
      option_lines: [],
      action_line: -1,
      task_line: -1,
    } as unknown as Reading;
    const card = readerCard(reading, lines);
    expect(card.headline).toBe("Fixed the rounding: amounts are scaled before they are rounded.");
    expect(card.summary).toEqual(["All 14 tests pass", "Not committed."]);
    // A finished turn asks nothing: no question, options or action.
    expect(card.question).toBeNull();
    expect(card.action).toBeNull();
  });

  it("shows a question and options only for an ask, and an action only for an approval", () => {
    const lines = ["Run npm test?", "❯ 1. Yes", "  2. No", "npm test"];
    const base = {
      status_line: 0,
      summary_lines: [],
      question_line: 0,
      option_lines: [1, 2],
      action_line: 3,
      task_line: -1,
    };
    const approval = readerCard({ ...base, category: "approval" } as unknown as Reading, lines);
    expect(approval).toMatchObject({
      question: "Run npm test?",
      options: ["1. Yes", "2. No"],
      action: "npm test",
    });
    const question = readerCard({ ...base, category: "question" } as unknown as Reading, lines);
    expect(question.action).toBeNull();
    expect(question.options).toHaveLength(2);
    const working = readerCard({ ...base, category: "working" } as unknown as Reading, lines);
    expect(working).toMatchObject({ question: null, options: [], action: null });
  });

  it("accepts only a reader.json this build can read", () => {
    expect(isReaderMeta(META)).toBe(true);
    expect(isReaderMeta({ ...META, outputs: META.outputs.filter((o) => o !== "task_line") })).toBe(
      false
    );
    expect(isReaderMeta({ ...META, max_len: 0 })).toBe(false);
    expect(isReaderMeta({ ...META, classes: { ...META.classes, score: [] } })).toBe(false);
    expect(isReaderMeta(null)).toBe(false);
  });

  it("loads the weights its install recorded, or whichever it holds when the record is lost", () => {
    const both = ["model.int8.onnx", "model.fp32.onnx", "reader.json"];
    expect(chooseWeightsFile({ weights: "fp32" }, both)).toBe("model.fp32.onnx");
    expect(chooseWeightsFile({ weights: "int8" }, both)).toBe("model.int8.onnx");
    // A manifest lost or unreadable: never INT8 that was not downloaded.
    expect(chooseWeightsFile(null, ["model.fp32.onnx"])).toBe("model.fp32.onnx");
    expect(chooseWeightsFile({}, ["model.int8.onnx"])).toBe("model.int8.onnx");
    // Recorded precision missing on disk: the other, rather than nothing.
    expect(chooseWeightsFile({ weights: "fp32" }, ["model.int8.onnx"])).toBe("model.int8.onnx");
    expect(chooseWeightsFile({ weights: "fp32" }, ["reader.json"])).toBeNull();
  });
});
