import { describe, expect, it } from "vitest";
import {
  extractAcronym,
  rankActionMatches,
  scoreAction,
  type SearchableAction,
} from "../actionPaletteSearch";

function makeAction(overrides: {
  id: string;
  title: string;
  category?: string;
  description?: string;
  enabled?: boolean;
}): SearchableAction {
  const category = overrides.category ?? "General";
  const description = overrides.description ?? "";
  return {
    id: overrides.id,
    title: overrides.title,
    category,
    description,
    enabled: overrides.enabled ?? true,
    titleLower: overrides.title.toLowerCase(),
    categoryLower: category.toLowerCase(),
    descriptionLower: description.toLowerCase(),
    titleAcronym: extractAcronym(overrides.title),
  };
}

describe("extractAcronym", () => {
  it("extracts first letters from space-separated words", () => {
    expect(extractAcronym("Command Palette")).toBe("cp");
    expect(extractAcronym("Open New Terminal")).toBe("ont");
  });

  it("treats hyphens, dots, underscores, slashes as boundaries", () => {
    expect(extractAcronym("git-status")).toBe("gs");
    expect(extractAcronym("dev.preview.toggle")).toBe("dpt");
    expect(extractAcronym("worktree/switch")).toBe("ws");
  });

  it("detects camelCase boundaries", () => {
    expect(extractAcronym("toggleDevPreview")).toBe("tdp");
  });

  it("returns empty string for empty input", () => {
    expect(extractAcronym("")).toBe("");
  });
});

describe("scoreAction", () => {
  it("returns 0 for empty query", () => {
    const item = makeAction({ id: "a", title: "Open Terminal" });
    expect(scoreAction("", item)).toBe(0);
  });

  it("returns 0 when query does not match any field", () => {
    const item = makeAction({ id: "a", title: "Open Terminal", description: "launches shell" });
    expect(scoreAction("xyz", item)).toBe(0);
  });

  it("ranks acronym match above scattered subsequence: 'cp' -> Command Palette", () => {
    const commandPalette = makeAction({ id: "cp", title: "Command Palette" });
    const completion = makeAction({ id: "c", title: "completion" });
    const scoreCp = scoreAction("cp", commandPalette);
    const scoreOther = scoreAction("cp", completion);
    expect(scoreCp).toBeGreaterThan(scoreOther);
  });

  it("acronym beats fuzzy subsequence even when query is embedded mid-word", () => {
    const acronym = makeAction({ id: "a", title: "Worktree Switch" });
    const fuzzy = makeAction({ id: "b", title: "show workspaces" });
    // 'ws' is acronym of "Worktree Switch" and a subsequence in "show workspaces"
    expect(scoreAction("ws", acronym)).toBeGreaterThan(scoreAction("ws", fuzzy));
  });

  it("ranks exact prefix above mid-title substring", () => {
    const prefix = makeAction({ id: "1", title: "Terminal Open" });
    const midWord = makeAction({ id: "2", title: "Open Terminal" });
    // Query "term" is a prefix of title 1 and a substring at boundary in title 2
    const scorePrefix = scoreAction("term", prefix);
    const scoreMid = scoreAction("term", midWord);
    expect(scorePrefix).toBeGreaterThan(scoreMid);
  });

  it("ranks exact substring above scattered subsequence", () => {
    const substring = makeAction({ id: "1", title: "Close Terminal" });
    const scattered = makeAction({ id: "2", title: "Toggle Error Messages" });
    // "term" is a substring in the first, and has a scattered subsequence in "Toggle..." (t...er...m)
    expect(scoreAction("term", substring)).toBeGreaterThan(scoreAction("term", scattered));
  });

  it("scores category matches but skips synthetic 'General'", () => {
    const general = makeAction({ id: "a", title: "Foo", category: "General" });
    // Query that would match "General" as a subsequence should not score
    expect(scoreAction("gen", general)).toBe(0);
  });

  it("counts real category text but at lower weight than title", () => {
    const titleHit = makeAction({ id: "1", title: "Git Commit", category: "Misc" });
    const categoryHit = makeAction({ id: "2", title: "Foo Bar", category: "Git" });
    expect(scoreAction("git", titleHit)).toBeGreaterThan(scoreAction("git", categoryHit));
    expect(scoreAction("git", categoryHit)).toBeGreaterThan(0);
  });

  it("description contributes at lowest weight", () => {
    const titleHit = makeAction({ id: "1", title: "Foo deploy", description: "" });
    const descHit = makeAction({ id: "2", title: "Other", description: "deploy the app" });
    expect(scoreAction("deploy", titleHit)).toBeGreaterThan(scoreAction("deploy", descHit));
    expect(scoreAction("deploy", descHit)).toBeGreaterThan(0);
  });
});

describe("rankActionMatches", () => {
  it("returns empty for empty or whitespace query", () => {
    const items = [makeAction({ id: "a", title: "Alpha" })];
    expect(rankActionMatches("", items, [])).toEqual([]);
    expect(rankActionMatches("   ", items, [])).toEqual([]);
  });

  it("filters out non-matching items", () => {
    const items = [
      makeAction({ id: "a", title: "Alpha" }),
      makeAction({ id: "b", title: "Bravo" }),
    ];
    expect(rankActionMatches("xyz", items, [])).toEqual([]);
  });

  it("sorts disabled items below enabled regardless of MRU or score", () => {
    const items = [
      makeAction({ id: "off", title: "Terminal Open", enabled: false }),
      makeAction({ id: "on", title: "Close Terminal", enabled: true }),
    ];
    const results = rankActionMatches("term", items, ["off"]);
    expect(results.map((r) => r.id)).toEqual(["on", "off"]);
  });

  it("MRU bonus resolves tied text scores", () => {
    const items = [
      makeAction({ id: "open", title: "Open Terminal" }),
      makeAction({ id: "close", title: "Close Terminal" }),
    ];
    const results = rankActionMatches("terminal", items, ["close"]);
    expect(results[0]!.id).toBe("close");
  });

  it("MRU bonus does not outrank a strong text match", () => {
    const items = [
      makeAction({ id: "exact", title: "Git Commit" }),
      makeAction({ id: "mru", title: "Something Else Git" }),
    ];
    const results = rankActionMatches("git commit", items, ["mru"]);
    expect(results[0]!.id).toBe("exact");
  });

  it("returns the original item references", () => {
    const alpha = makeAction({ id: "a", title: "Alpha" });
    const bravo = makeAction({ id: "b", title: "Bravo" });
    const results = rankActionMatches("alpha", [alpha, bravo], []);
    expect(results[0]).toBe(alpha);
  });

  it("keeps identical-acronym matches above non-acronym subsequence matches", () => {
    const items = [
      makeAction({ id: "cp", title: "Command Palette" }),
      makeAction({ id: "cpanel", title: "Close Panel" }),
      makeAction({ id: "copy", title: "copy path" }),
      makeAction({ id: "comp", title: "completion" }),
    ];
    const results = rankActionMatches("cp", items, []);
    // All three acronym-like matches (including "copy path" which is prefix match)
    // outrank scattered subsequence "completion"
    const ids = results.map((r) => r.id);
    expect(ids.indexOf("comp")).toBe(ids.length - 1);
    expect(ids.slice(0, 3).sort()).toEqual(["copy", "cp", "cpanel"].sort());
  });

  it("disambiguates identical acronyms by alphabetical title when scores tie", () => {
    const items = [
      makeAction({ id: "cpanel", title: "Close Panel" }),
      makeAction({ id: "cp", title: "Command Palette" }),
    ];
    // Query is the shared acronym; tiebreaker should be deterministic alphabetical
    const results = rankActionMatches("cp", items, []);
    expect(results).toHaveLength(2);
    // Both are valid matches — order must be deterministic (alphabetical on title)
    expect(results[0]!.title < results[1]!.title || results[0]!.title === results[1]!.title).toBe(
      true
    );
  });

  it("full ranked list: prefix > acronym > substring > fuzzy > non-match", () => {
    const items = [
      makeAction({ id: "prefix", title: "Terminal Open" }), // 'term' prefix
      makeAction({ id: "acronym", title: "Toggle Error Markers" }), // 'tem' acronym — different query
      makeAction({ id: "substring", title: "Close Terminal" }), // 'term' boundary substring
      makeAction({ id: "fuzzy", title: "take error messages" }), // 'term' scattered
      makeAction({ id: "none", title: "unrelated" }),
    ];
    const results = rankActionMatches("term", items, []);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("none");
    expect(ids[0]).toBe("prefix");
    expect(ids.indexOf("substring")).toBeLessThan(ids.indexOf("fuzzy"));
  });

  it("falls back to title alphabetical for equal score with no MRU", () => {
    const items = [
      makeAction({ id: "b", title: "Beta Terminal" }),
      makeAction({ id: "a", title: "Alpha Terminal" }),
    ];
    const results = rankActionMatches("terminal", items, []);
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
