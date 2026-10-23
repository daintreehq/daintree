import { describe, expect, it } from "vitest";
import {
  PLUGIN_APPLICATION_NAVIGATION_LIMITS as LIMITS,
  type PluginApplicationNavigation,
  type PluginNavigationLocation,
} from "../../types/plugin.js";
import {
  decodeNavigationLocation,
  persistableNavigationHistory,
  pushNavigationHistory,
  restoreNavigationHistory,
  type NavigationHistory,
} from "../applicationNavigation.js";

const NAVIGATION: PluginApplicationNavigation = {
  version: 1,
  defaultSectionId: "overview",
  sections: [
    { id: "overview", title: "Overview" },
    {
      id: "record",
      title: "Record",
      params: {
        recordId: { type: "string", required: true, persist: true, maxLength: 16 },
        tab: { type: "integer" },
        pinned: { type: "boolean", persist: true },
      },
    },
    { id: "search", title: "Search", params: { term: { type: "string", required: true } } },
  ],
};

function at(sectionId: string, params: Record<string, string | number | boolean> = {}) {
  const decoded = decodeNavigationLocation(NAVIGATION, sectionId, params);
  if (!decoded.ok) throw new Error(`fixture ${sectionId} does not decode: ${decoded.reason}`);
  return decoded.location;
}

describe("decodeNavigationLocation", () => {
  it("admits declared parameters of their declared types", () => {
    const decoded = decodeNavigationLocation(NAVIGATION, "record", {
      recordId: "inv-42",
      tab: 3,
      pinned: false,
    });
    expect(decoded).toEqual({
      ok: true,
      location: { sectionId: "record", params: { pinned: false, recordId: "inv-42", tab: 3 } },
    });
    expect(decoded.ok && Object.isFrozen(decoded.location.params)).toBe(true);
  });

  it("detaches the location from the caller's object", () => {
    const params: Record<string, unknown> = { recordId: "a" };
    const decoded = decodeNavigationLocation(NAVIGATION, "record", params);
    params.recordId = "b";
    expect(decoded.ok && decoded.location.params.recordId).toBe("a");
  });

  it("refuses an undeclared section", () => {
    expect(decodeNavigationLocation(NAVIGATION, "settings", {})).toEqual({
      ok: false,
      reason: "unknown-section",
    });
    expect(decodeNavigationLocation(NAVIGATION, 7, {})).toEqual({
      ok: false,
      reason: "unknown-section",
    });
  });

  it.each([
    ["an undeclared parameter", { recordId: "a", note: "x" }],
    ["a missing required parameter", { tab: 1 }],
    ["free text in a string", { recordId: "hello world" }],
    ["a URL in a string", { recordId: "https://x" }],
    ["a string over its maxLength", { recordId: "a".repeat(17) }],
    ["an empty string", { recordId: "" }],
    ["a fractional integer", { recordId: "a", tab: 1.5 }],
    ["an unsafe integer", { recordId: "a", tab: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN", { recordId: "a", tab: Number.NaN }],
    ["a string for a boolean", { recordId: "a", pinned: "true" }],
    ["a nested object", { recordId: { id: "a" } }],
  ])("refuses %s", (_label, params) => {
    expect(decodeNavigationLocation(NAVIGATION, "record", params)).toEqual({
      ok: false,
      reason: "invalid-params",
    });
  });

  it("refuses prototype keys even when smuggled in as own properties", () => {
    const params = JSON.parse('{"recordId":"a","__proto__":{"polluted":true}}') as unknown;
    expect(decodeNavigationLocation(NAVIGATION, "record", params)).toEqual({
      ok: false,
      reason: "invalid-params",
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a params value that is not a plain object", () => {
    expect(decodeNavigationLocation(NAVIGATION, "overview", ["a"])).toEqual({
      ok: false,
      reason: "invalid-params",
    });
    expect(decodeNavigationLocation(NAVIGATION, "overview", new Map())).toEqual({
      ok: false,
      reason: "invalid-params",
    });
  });

  it("treats an undefined parameter as absent", () => {
    expect(
      decodeNavigationLocation(NAVIGATION, "record", { recordId: "a", tab: undefined })
    ).toEqual({ ok: true, location: { sectionId: "record", params: { recordId: "a" } } });
  });
});

describe("pushNavigationHistory", () => {
  const start: NavigationHistory = { entries: [at("overview")], index: 0 };

  it("returns the same history for a move to where it already is", () => {
    expect(pushNavigationHistory(start, at("overview"), false)).toBe(start);
  });

  it("drops the forward entries on a new move", () => {
    const two = pushNavigationHistory(start, at("record", { recordId: "a" }), false);
    const back: NavigationHistory = { entries: two.entries, index: 0 };
    const next = pushNavigationHistory(back, at("search", { term: "q" }), false);
    expect(next.entries.map((entry) => entry.sectionId)).toEqual(["overview", "search"]);
    expect(next.index).toBe(1);
  });

  it("replaces the current entry and keeps the forward ones", () => {
    const history: NavigationHistory = {
      entries: [at("overview"), at("record", { recordId: "a" }), at("search", { term: "q" })],
      index: 1,
    };
    const next = pushNavigationHistory(history, at("record", { recordId: "b" }), true);
    expect(next.entries.map((entry) => entry.params.recordId ?? entry.sectionId)).toEqual([
      "overview",
      "b",
      "search",
    ]);
    expect(next.index).toBe(1);
  });

  it("caps the history, dropping the oldest entries", () => {
    let history = start;
    for (let i = 0; i < LIMITS.maxHistoryEntries + 5; i++) {
      history = pushNavigationHistory(history, at("record", { recordId: `r${i}` }), false);
    }
    expect(history.entries).toHaveLength(LIMITS.maxHistoryEntries);
    expect(history.index).toBe(LIMITS.maxHistoryEntries - 1);
    expect(history.entries[history.index]?.params.recordId).toBe(
      `r${LIMITS.maxHistoryEntries + 4}`
    );
  });
});

describe("restoreNavigationHistory", () => {
  it("falls back to the default section for nothing stored", () => {
    expect(restoreNavigationHistory(NAVIGATION, undefined, undefined)).toEqual({
      entries: [{ sectionId: "overview", params: {} }],
      index: 0,
    });
  });

  it("drops entries that no longer resolve and keeps the cursor on its entry", () => {
    const restored = restoreNavigationHistory(
      NAVIGATION,
      [
        { sectionId: "overview", params: {} },
        { sectionId: "removed", params: {} },
        { sectionId: "record", params: { recordId: "a" } },
        { sectionId: "record", params: { recordId: "bad id" } },
        { sectionId: "search", params: { term: "q" } },
      ],
      2
    );
    expect(restored.entries.map((entry) => entry.sectionId)).toEqual([
      "overview",
      "record",
      "search",
    ]);
    expect(restored.index).toBe(1);
  });

  it("lands the current entry on the default section when it no longer resolves", () => {
    const restored = restoreNavigationHistory(
      NAVIGATION,
      [
        { sectionId: "record", params: { recordId: "a" } },
        { sectionId: "removed", params: {} },
      ],
      1
    );
    expect(restored.entries).toEqual([
      { sectionId: "record", params: { recordId: "a" } },
      { sectionId: "overview", params: {} },
    ]);
    expect(restored.index).toBe(1);
  });

  it("collapses repeats left next to each other by a dropped entry", () => {
    const restored = restoreNavigationHistory(
      NAVIGATION,
      [
        { sectionId: "overview", params: {} },
        { sectionId: "removed", params: {} },
        { sectionId: "overview", params: {} },
      ],
      2
    );
    expect(restored).toEqual({ entries: [{ sectionId: "overview", params: {} }], index: 0 });
  });

  it("takes the last entry when the stored cursor is out of range", () => {
    const restored = restoreNavigationHistory(
      NAVIGATION,
      [
        { sectionId: "overview", params: {} },
        { sectionId: "search", params: { term: "q" } },
      ],
      9
    );
    expect(restored.index).toBe(1);
  });

  it("never hands out a stored entry a view could mutate", () => {
    const entry = { sectionId: "record", params: { recordId: "a" } };
    const restored = restoreNavigationHistory(NAVIGATION, [entry], 0);
    expect(restored.entries[0]).not.toBe(entry);
    expect(restored.entries[0]).toEqual(entry);
    expect(Object.isFrozen(restored.entries[0]?.params)).toBe(true);
  });

  it("keeps the identity of an entry that resolves unchanged", () => {
    const entry: PluginNavigationLocation = at("record", { recordId: "a" });
    const restored = restoreNavigationHistory(NAVIGATION, [entry], 0);
    expect(restored.entries[0]).toBe(entry);
  });
});

describe("persistableNavigationHistory", () => {
  it("keeps only the parameters marked persist", () => {
    const history: NavigationHistory = {
      entries: [at("record", { recordId: "a", tab: 2, pinned: true })],
      index: 0,
    };
    expect(persistableNavigationHistory(NAVIGATION, history).entries).toEqual([
      { sectionId: "record", params: { pinned: true, recordId: "a" } },
    ]);
  });

  it("writes the default section for an entry whose required parameter is session-only", () => {
    const history: NavigationHistory = {
      entries: [at("overview"), at("search", { term: "q" })],
      index: 1,
    };
    expect(persistableNavigationHistory(NAVIGATION, history)).toEqual({
      entries: [{ sectionId: "overview", params: {} }],
      index: 0,
    });
  });
});
