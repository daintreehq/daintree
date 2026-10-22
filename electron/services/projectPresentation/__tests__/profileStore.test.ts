import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  MAX_REMEMBERED_ANSWERS,
  answerFor,
  answerProjectPresentationSuggestion,
  getProjectPresentation,
  setProjectPresentationLevel,
} from "../profileStore.js";
import { hashPresentationLevels } from "../repoSuggestion.js";
import type { PresentationSuggestion } from "../../../../shared/types/ipc/projectPresentation.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function suggest(levels: PresentationSuggestion["levels"]): PresentationSuggestion {
  return { levels, hash: hashPresentationLevels(levels) };
}

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
});

describe("project presentation levels", () => {
  it("records a level per project and forgets it with null", () => {
    expect(setProjectPresentationLevel(PROJECT_A, "forgeStats", "demoted").levels).toEqual({
      forgeStats: "demoted",
    });
    expect(getProjectPresentation(PROJECT_A).levels).toEqual({ forgeStats: "demoted" });
    expect(getProjectPresentation(PROJECT_B).levels).toEqual({});

    setProjectPresentationLevel(PROJECT_A, "forgeStats", null);
    expect(getProjectPresentation(PROJECT_A).levels).toEqual({});
    // A project left with nothing set takes no room in the store.
    expect(storeMock.data.get("projectPresentation")).toEqual({});
  });

  it("refuses unknown features, unsupported levels and non-project ids before writing", () => {
    expect(() => setProjectPresentationLevel(PROJECT_A, "agentState" as never, "hidden")).toThrow(
      /unknown feature/
    );
    expect(() => setProjectPresentationLevel(PROJECT_A, "forgeStats", "gone" as never)).toThrow(
      /no level gone/
    );
    expect(() =>
      setProjectPresentationLevel("0c1d2e3f-0000-4000-8000-000000000000", "forgeStats", "hidden")
    ).toThrow(/project workspace id/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("keeps a level a newer build wrote for a feature this one does not know", () => {
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: { levels: { futureFeature: "hidden" }, extra: 1 },
    });

    setProjectPresentationLevel(PROJECT_A, "forgeStats", "hidden");

    expect(storeMock.data.get("projectPresentation")).toEqual({
      [PROJECT_A]: { levels: { futureFeature: "hidden", forgeStats: "hidden" }, extra: 1 },
    });
    expect(getProjectPresentation(PROJECT_A).levels).toEqual({ forgeStats: "hidden" });
  });

  it("skips malformed stored entries rather than failing the read", () => {
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: {
        levels: { forgeStats: 7 },
        suggestionAnswers: { h1: { answer: "yes" }, h2: { answer: "declined", decidedAt: 3 } },
      },
    });
    const stored = getProjectPresentation(PROJECT_A);
    expect(stored.levels).toEqual({});
    expect({ ...stored.suggestionAnswers }).toEqual({ h2: { answer: "declined", decidedAt: 3 } });
  });

  it("propagates an unreadable store instead of writing over every other project", () => {
    storeMock.get.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => getProjectPresentation(PROJECT_A)).toThrow("EACCES");
    expect(() => setProjectPresentationLevel(PROJECT_A, "forgeStats", "hidden")).toThrow("EACCES");
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("answering the repository's suggestion", () => {
  it("accepting copies the suggested levels into the user's own profile", () => {
    setProjectPresentationLevel(PROJECT_A, "forgeStats", "demoted");
    const suggestion = suggest({ forgeStats: "hidden" });

    const stored = answerProjectPresentationSuggestion(
      PROJECT_A,
      suggestion,
      suggestion.hash,
      "accepted",
      42
    );

    expect(stored.levels).toEqual({ forgeStats: "hidden" });
    expect(answerFor(stored, suggestion)).toEqual({
      hash: suggestion.hash,
      answer: "accepted",
      decidedAt: 42,
    });
  });

  it("declining remembers the answer and changes no level", () => {
    setProjectPresentationLevel(PROJECT_A, "forgeStats", "demoted");
    const suggestion = suggest({ forgeStats: "hidden" });

    const stored = answerProjectPresentationSuggestion(
      PROJECT_A,
      suggestion,
      suggestion.hash,
      "declined",
      7
    );

    expect(stored.levels).toEqual({ forgeStats: "demoted" });
    expect(answerFor(stored, suggestion)).toEqual({
      hash: suggestion.hash,
      answer: "declined",
      decidedAt: 7,
    });
  });

  it("remembers each suggestion's answer, so switching branches back asks nothing", () => {
    const a = suggest({ forgeStats: "hidden" });
    const b = suggest({ forgeStats: "demoted" });
    answerProjectPresentationSuggestion(PROJECT_A, a, a.hash, "declined", 1);
    answerProjectPresentationSuggestion(PROJECT_A, b, b.hash, "declined", 2);

    const stored = getProjectPresentation(PROJECT_A);
    expect(answerFor(stored, a)?.answer).toBe("declined");
    expect(answerFor(stored, b)?.answer).toBe("declined");
    expect(answerFor(stored, null)).toBeNull();
    expect(stored.levels).toEqual({});
  });

  it("keeps only the most recent answers", () => {
    const suggestion = suggest({ forgeStats: "hidden" });
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: {
        suggestionAnswers: Object.fromEntries(
          Array.from({ length: MAX_REMEMBERED_ANSWERS }, (_, i) => [
            `old-${i}`,
            { answer: "declined", decidedAt: i },
          ])
        ),
      },
    });

    const stored = answerProjectPresentationSuggestion(
      PROJECT_A,
      suggestion,
      suggestion.hash,
      "declined",
      1000
    );

    expect(Object.keys(stored.suggestionAnswers)).toHaveLength(MAX_REMEMBERED_ANSWERS);
    expect(Object.hasOwn(stored.suggestionAnswers, "old-0")).toBe(false);
    expect(answerFor(stored, suggestion)?.decidedAt).toBe(1000);
  });

  it("refuses an answer about a suggestion the file no longer makes", () => {
    const shown = suggest({ forgeStats: "hidden" });
    const now = suggest({ forgeStats: "demoted" });

    expect(() =>
      answerProjectPresentationSuggestion(PROJECT_A, now, shown.hash, "accepted")
    ).toThrow(/suggestion has changed/);
    expect(() =>
      answerProjectPresentationSuggestion(PROJECT_A, null, shown.hash, "accepted")
    ).toThrow(/suggestion has changed/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});
