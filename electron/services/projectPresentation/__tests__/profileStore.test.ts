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
  isOwnProjectPluginButtonId,
  resetProjectToolbar,
  setProjectFeaturedLaunchEntry,
  setProjectLauncherGroupOrder,
  setProjectPluginButtonPromoted,
  setProjectPresentationLevel,
  setProjectToolbarEnabled,
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
  });

  it("counts every write in a revision that never goes back, even once nothing is set", () => {
    expect(getProjectPresentation(PROJECT_A).revision).toBe(0);
    setProjectPresentationLevel(PROJECT_A, "forgeStats", "demoted");
    setProjectPresentationLevel(PROJECT_A, "forgeStats", null);
    // Dropping the emptied entry would restart the count below what an open
    // view already holds, and that view would refuse every later snapshot.
    expect(getProjectPresentation(PROJECT_A).revision).toBe(2);
    const suggestion = suggest({ forgeStats: "hidden" });
    answerProjectPresentationSuggestion(PROJECT_A, suggestion, suggestion.hash, "declined");
    expect(getProjectPresentation(PROJECT_A).revision).toBe(3);
    expect(getProjectPresentation(PROJECT_B).revision).toBe(0);
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
      [PROJECT_A]: {
        levels: { futureFeature: "hidden", forgeStats: "hidden" },
        extra: 1,
        revision: 1,
      },
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

  it("never drops the answer just given, whatever timestamps an edited file holds", () => {
    const suggestion = suggest({ forgeStats: "hidden" });
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: {
        suggestionAnswers: Object.fromEntries(
          Array.from({ length: MAX_REMEMBERED_ANSWERS }, (_, i) => [
            `future-${i}`,
            { answer: "declined", decidedAt: 1e15 + i },
          ])
        ),
      },
    });

    const stored = answerProjectPresentationSuggestion(
      PROJECT_A,
      suggestion,
      suggestion.hash,
      "accepted",
      5
    );

    expect(answerFor(stored, suggestion)?.answer).toBe("accepted");
    expect(Object.keys(stored.suggestionAnswers)).toHaveLength(MAX_REMEMBERED_ANSWERS);
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

describe("project toolbar (#13783)", () => {
  const own = (n: number) => `project__${PROJECT_A}__acme.tools.btn${n}`;

  it("accepts only this project's own plugin buttons", () => {
    expect(isOwnProjectPluginButtonId(PROJECT_A, own(1))).toBe(true);
    // An installed plugin's button, another project's, and a bare instance key.
    expect(isOwnProjectPluginButtonId(PROJECT_A, "acme.tools.btn")).toBe(false);
    expect(isOwnProjectPluginButtonId(PROJECT_A, `project__${PROJECT_B}__acme.tools.btn`)).toBe(
      false
    );
    expect(isOwnProjectPluginButtonId(PROJECT_A, `project__${PROJECT_A}__acme`)).toBe(false);
    // A bare instance key: manifest names are `publisher.name`, so this is the
    // plugin itself, not one of its buttons.
    expect(isOwnProjectPluginButtonId(PROJECT_A, `project__${PROJECT_A}__acme.tools`)).toBe(false);
    // A button id may itself hold dots, even empty segments.
    expect(
      isOwnProjectPluginButtonId(PROJECT_A, `project__${PROJECT_A}__acme.tools.run..all`)
    ).toBe(true);
    expect(() => setProjectPluginButtonPromoted(PROJECT_A, "acme.tools.btn", true)).toThrow();
  });

  it("promotes up to three buttons, in order, and refuses a fourth", () => {
    setProjectPluginButtonPromoted(PROJECT_A, own(1), true);
    setProjectPluginButtonPromoted(PROJECT_A, own(2), true);
    // Promoting again is not a second entry.
    setProjectPluginButtonPromoted(PROJECT_A, own(2), true);
    setProjectPluginButtonPromoted(PROJECT_A, own(3), true);
    expect(getProjectPresentation(PROJECT_A).promotedPluginButtons).toEqual([
      own(1),
      own(2),
      own(3),
    ]);
    expect(() => setProjectPluginButtonPromoted(PROJECT_A, own(4), true)).toThrow(/at most 3/);
    expect(setProjectPluginButtonPromoted(PROJECT_A, own(2), false).promotedPluginButtons).toEqual([
      own(1),
      own(3),
    ]);
  });

  it("reads a hand-edited list deduped, own-project only and capped", () => {
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: {
        promotedPluginButtons: [
          own(1),
          `project__${PROJECT_A}__acme.tools`,
          own(1),
          "acme.tools.btn",
          7,
          own(2),
          own(3),
          own(4),
        ],
        useProjectToolbar: "yes",
      },
    });
    const stored = getProjectPresentation(PROJECT_A);
    expect(stored.promotedPluginButtons).toEqual([own(1), own(2), own(3)]);
    expect(stored.useProjectToolbar).toBeNull();
  });

  it("keeps every toolbar choice while the toggle is off", () => {
    setProjectPresentationLevel(PROJECT_A, "copyTree", "demoted");
    setProjectPluginButtonPromoted(PROJECT_A, own(1), true);
    const off = setProjectToolbarEnabled(PROJECT_A, false);
    expect(off.useProjectToolbar).toBe(false);
    expect(off.levels).toEqual({ copyTree: "demoted" });
    expect(off.promotedPluginButtons).toEqual([own(1)]);
  });

  it("turns the toggle back to following the profile when a toolbar level is chosen", () => {
    setProjectToolbarEnabled(PROJECT_A, false);
    // Git detail sits on worktree cards, so choosing it says nothing about the toolbar.
    expect(setProjectPresentationLevel(PROJECT_A, "gitDetail", "demoted").useProjectToolbar).toBe(
      false
    );
    // The dev preview is the project's on every surface (#14069), not its toolbar's.
    expect(setProjectPresentationLevel(PROJECT_A, "devServer", "hidden").useProjectToolbar).toBe(
      false
    );
    expect(setProjectPresentationLevel(PROJECT_A, "copyTree", "demoted").useProjectToolbar).toBe(
      null
    );
  });

  it("keeps the project's dev preview choice when its toolbar is reset", () => {
    setProjectPresentationLevel(PROJECT_A, "copyTree", "demoted");
    setProjectPresentationLevel(PROJECT_A, "devServer", "hidden");
    expect(resetProjectToolbar(PROJECT_A).levels).toEqual({ devServer: "hidden" });
  });

  it("resets only the toolbar, keeping answers, other projects and the revision count", () => {
    const suggestion = suggest({ forgeStats: "hidden" });
    answerProjectPresentationSuggestion(PROJECT_A, suggestion, suggestion.hash, "declined", 5);
    setProjectPresentationLevel(PROJECT_A, "copyTree", "demoted");
    setProjectPresentationLevel(PROJECT_A, "gitDetail", "demoted");
    setProjectPluginButtonPromoted(PROJECT_A, own(1), true);
    setProjectToolbarEnabled(PROJECT_A, true);
    setProjectPresentationLevel(PROJECT_B, "copyTree", "demoted");
    const before = getProjectPresentation(PROJECT_A).revision;

    const reset = resetProjectToolbar(PROJECT_A);
    expect(reset.levels).toEqual({ gitDetail: "demoted" });
    expect(reset.promotedPluginButtons).toEqual([]);
    expect(reset.useProjectToolbar).toBeNull();
    expect(reset.suggestionAnswers[suggestion.hash]?.answer).toBe("declined");
    expect(reset.revision).toBe(before + 1);
    expect(getProjectPresentation(PROJECT_B).levels).toEqual({ copyTree: "demoted" });
  });

  it("keeps a level from a newer build through a toolbar reset", () => {
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: { levels: { copyTree: "demoted", futureFeature: "demoted" } },
    });
    resetProjectToolbar(PROJECT_A);
    const raw = storeMock.data.get("projectPresentation") as Record<
      string,
      { levels?: Record<string, string> }
    >;
    expect(raw[PROJECT_A]?.levels).toEqual({ futureFeature: "demoted" });
  });
});

describe("launcher arrangement (#13791)", () => {
  it("stores the user's group order whole, and hands it back to the profile with []", () => {
    const stored = setProjectLauncherGroupOrder(PROJECT_A, ["recipes", "plugin:acme.tools"]);
    expect(stored.launcherGroupOrder).toEqual(["recipes", "plugin:acme.tools"]);
    expect(getProjectPresentation(PROJECT_B).launcherGroupOrder).toEqual([]);
    const cleared = setProjectLauncherGroupOrder(PROJECT_A, []);
    expect(cleared.launcherGroupOrder).toEqual([]);
    expect(cleared.revision).toBe(stored.revision + 1);
    expect(storeMock.data.get("projectPresentation")).toEqual({
      [PROJECT_A]: { revision: 2 },
    });
  });

  it("refuses an order holding a malformed or repeated group", () => {
    expect(() => setProjectLauncherGroupOrder(PROJECT_A, ["agents", "agents"])).toThrow();
    expect(() => setProjectLauncherGroupOrder(PROJECT_A, ["agents", ""])).toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("features one entry by its machine-independent name, and lets it go with null", () => {
    expect(setProjectFeaturedLaunchEntry(PROJECT_A, "acme.records.new").featuredLaunchEntry).toBe(
      "acme.records.new"
    );
    expect(() =>
      setProjectFeaturedLaunchEntry(PROJECT_A, `project__${PROJECT_A}__acme.records.new`)
    ).toThrow();
    expect(setProjectFeaturedLaunchEntry(PROJECT_A, null).featuredLaunchEntry).toBeNull();
  });

  it("reads a hand-edited entry leniently", () => {
    storeMock.data.set("projectPresentation", {
      [PROJECT_A]: {
        launcherGroupOrder: ["agents", 4, "agents", "plugin:x"],
        featuredLaunchEntry: "not a ref",
      },
    });
    const stored = getProjectPresentation(PROJECT_A);
    expect(stored.launcherGroupOrder).toEqual(["agents", "plugin:x"]);
    expect(stored.featuredLaunchEntry).toBeNull();
  });

  it("accepting a suggestion copies its featured entry, and one without leaves the choice", () => {
    setProjectFeaturedLaunchEntry(PROJECT_A, "acme.records.old");
    const levelsOnly = suggest({ launcherAgents: "demoted" });
    expect(
      answerProjectPresentationSuggestion(PROJECT_A, levelsOnly, levelsOnly.hash, "accepted")
        .featuredLaunchEntry
    ).toBe("acme.records.old");

    const featured: PresentationSuggestion = {
      levels: {},
      featuredLaunchEntry: "acme.records.new",
      hash: hashPresentationLevels({}, "acme.records.new"),
    };
    expect(
      answerProjectPresentationSuggestion(PROJECT_A, featured, featured.hash, "declined")
        .featuredLaunchEntry
    ).toBe("acme.records.old");
    expect(
      answerProjectPresentationSuggestion(PROJECT_A, featured, featured.hash, "accepted")
        .featuredLaunchEntry
    ).toBe("acme.records.new");
  });

  it("keeps the launcher's choices through a toolbar reset", () => {
    setProjectLauncherGroupOrder(PROJECT_A, ["recipes"]);
    setProjectFeaturedLaunchEntry(PROJECT_A, "acme.records.new");
    setProjectPresentationLevel(PROJECT_A, "launcherPanels", "demoted");
    const stored = resetProjectToolbar(PROJECT_A);
    expect(stored.launcherGroupOrder).toEqual(["recipes"]);
    expect(stored.featuredLaunchEntry).toBe("acme.records.new");
    expect(stored.levels).toEqual({ launcherPanels: "demoted" });
  });
});
