import { describe, expect, it } from "vitest";
import {
  MODEL_ADAPTERS,
  NO_ADAPTER,
  abstainReasonText,
  adapterChoiceDescription,
  answeringText,
  bucketRangeText,
  historyText,
  matchedText,
  reportSummary,
  thresholdChoiceText,
} from "../decisionModelCopy";
import { DECISIONS_MODEL_ADAPTERS } from "@shared/types/decisions";

describe("decision model copy", () => {
  it("names a destination for every CLI the setting accepts, and none for no CLI", () => {
    for (const adapter of DECISIONS_MODEL_ADAPTERS) {
      const text = adapterChoiceDescription(adapter);
      expect(text).toContain(MODEL_ADAPTERS[adapter].provider);
      expect(text).toContain(MODEL_ADAPTERS[adapter].command);
    }
    expect(adapterChoiceDescription(NO_ADAPTER)).toContain("Nothing is sent");
  });

  it("counts matches with their share, and shows no share with nothing to divide by", () => {
    expect(matchedText(37, 40)).toBe("37 of 40 (93%)");
    expect(matchedText(0, 0)).toBe("none answered");
  });

  it("gives the last band its upper bound and every other an open one", () => {
    expect(bucketRangeText({ lo: 0.5, hi: 0.6, answered: 1, matched: 1 }, false)).toBe(
      "0.50 to under 0.60"
    );
    expect(bucketRangeText({ lo: 0.9, hi: 1, answered: 1, matched: 1 }, true)).toBe(
      "0.90 to 1.00"
    );
  });

  it("states each threshold with its evidence", () => {
    expect(thresholdChoiceText({ threshold: 0.8, answered: 31, matched: 30 })).toBe(
      "At confidence 0.80 or higher: matched 30 of 31 (97%)"
    );
    expect(thresholdChoiceText({ threshold: 0, answered: 40, matched: 38 })).toMatch(
      /^At any confidence/
    );
  });

  it("describes the history as observed, counting with the plural helper", () => {
    expect(historyText({ state: "open", count: 1 })).toContain("1 answer ");
    expect(historyText({ state: "open", count: 2 })).toContain("2 answers");
    expect(historyText({ state: "open", count: 0 })).toContain("Nothing learned yet");
    expect(historyText({ state: "closed", stored: true })).toContain("still stored");
    expect(historyText({ state: "closed", stored: false })).toBe("Nothing is stored.");
    expect(historyText({ state: "unavailable" })).toContain("isn't open");
  });

  it("says nothing answers unless main reports a threshold in force", () => {
    expect(answeringText({ answeringFrom: null, adapter: "claude" }, true)).toContain(
      "doesn't answer anything"
    );
    const on = answeringText({ answeringFrom: 0.8, adapter: "claude" }, false);
    expect(on).toContain("Claude Code");
    expect(on).toContain("0.80 or higher");
    expect(on).toContain("labelled as a proxy's answer");
  });

  it("puts the library's reasons in words, and shows one it doesn't know as it is", () => {
    expect(abstainReasonText("model-error")).not.toBe("model-error");
    expect(abstainReasonText("a-new-reason")).toBe("a-new-reason");
  });

  it("says when nothing could be scored, and otherwise how often it matched", () => {
    expect(reportSummary({ total: 3, scored: 0, answered: 0, matched: 0 })).toContain(
      "nothing was scored"
    );
    expect(reportSummary({ total: 10, scored: 8, answered: 0, matched: 0 })).toContain(
      "answered none"
    );
    expect(reportSummary({ total: 10, scored: 8, answered: 4, matched: 3 })).toBe(
      "Of 8 past questions it could compare, the model answered 4 and matched your answer on 3 of 4 (75%)."
    );
  });
});
