import { describe, it, expect } from "vitest";
import {
  MAX_BACKGROUND_PROJECTS_PER_WINDOW,
  MAX_RESTORED_WINDOWS,
  OPEN_WINDOWS_MANIFEST_VERSION,
  filterRestorableWindows,
  isReadableOpenWindowsManifest,
  parseOpenWindowsManifest,
  serializeOpenWindowsManifest,
  type OpenWindowRecord,
} from "../windowManifest.js";

const record = (projectId: string | null): OpenWindowRecord => ({ projectId });

/** Builds a manifest at the CURRENT version, so a version bump can't turn a
 *  malformed-shape test into a false positive by being rejected on version. */
const manifestJson = (windows: unknown[]): string =>
  JSON.stringify({ version: OPEN_WINDOWS_MANIFEST_VERSION, windows });

describe("parseOpenWindowsManifest", () => {
  it("round-trips what serialize produced", () => {
    const records = [record("alpha"), record(null), record("beta")];
    expect(parseOpenWindowsManifest(serializeOpenWindowsManifest(records))).toEqual(records);
  });

  it("preserves record order — order is the focus order", () => {
    const records = [record("c"), record("a"), record("b")];
    const parsed = parseOpenWindowsManifest(serializeOpenWindowsManifest(records));
    expect(parsed.map((r) => r.projectId)).toEqual(["c", "a", "b"]);
  });

  it("keeps duplicate project ids as separate windows", () => {
    // Two windows can legitimately show the same project, so the manifest is a
    // list of windows and must never collapse to a set of project ids.
    const parsed = parseOpenWindowsManifest(
      serializeOpenWindowsManifest([record("a"), record("a")])
    );
    expect(parsed).toHaveLength(2);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"hello"'],
    ["JSON null", "null"],
  ])("returns nothing for %s", (_label, raw) => {
    expect(parseOpenWindowsManifest(raw)).toEqual([]);
  });

  it("refuses a version it cannot read rather than guessing at fields", () => {
    const future = JSON.stringify({
      version: OPEN_WINDOWS_MANIFEST_VERSION + 1,
      windows: [{ projectId: "a" }],
    });
    expect(parseOpenWindowsManifest(future)).toEqual([]);
  });

  it("refuses a manifest with no version", () => {
    expect(parseOpenWindowsManifest(JSON.stringify({ windows: [{ projectId: "a" }] }))).toEqual([]);
  });

  it("refuses a manifest whose windows is not an array", () => {
    expect(parseOpenWindowsManifest(manifestJson([]).replace("[]", "{}"))).toEqual([]);
  });

  it("drops malformed entries but keeps the sound ones around them", () => {
    const raw = manifestJson([
      { projectId: "good" },
      { projectId: 42 },
      "not-an-object",
      null,
      { projectId: "" },
      {},
      { projectId: null },
      { projectId: "also-good" },
    ]);
    expect(parseOpenWindowsManifest(raw)).toEqual([
      record("good"),
      record(null),
      record("also-good"),
    ]);
  });

  it("caps a manifest that would otherwise launch an unbounded fleet", () => {
    const inputIds = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const parsed = parseOpenWindowsManifest(
      manifestJson(inputIds.map((id) => ({ projectId: id })))
    );
    // Trimmed from the tail, so the most-recently-focused windows survive.
    expect(parsed.map((r) => r.projectId)).toEqual(inputIds.slice(0, MAX_RESTORED_WINDOWS));
  });

  it("ignores extra unknown fields on an entry", () => {
    const raw = manifestJson([{ projectId: "a", windowId: 7, bounds: { x: 1 } }]);
    expect(parseOpenWindowsManifest(raw)).toEqual([record("a")]);
  });
});

describe("serializeOpenWindowsManifest", () => {
  it("stamps the version so a later shape change is detectable", () => {
    const parsed: unknown = JSON.parse(serializeOpenWindowsManifest([record("a")]));
    expect(parsed).toMatchObject({ windows: [{ projectId: "a" }] });
    expect((parsed as { version: unknown }).version).toEqual(expect.any(Number));
  });

  it("never persists more than the cap, trimming from the tail", () => {
    const inputIds = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const parsed = JSON.parse(serializeOpenWindowsManifest(inputIds.map(record))) as {
      windows: OpenWindowRecord[];
    };
    expect(parsed.windows.map((r) => r.projectId)).toEqual(inputIds.slice(0, MAX_RESTORED_WINDOWS));
  });

  it("writes only the projectId, never an ephemeral Electron window id", () => {
    const withExtras = [{ projectId: "a", windowId: 3 } as OpenWindowRecord];
    expect(serializeOpenWindowsManifest(withExtras)).not.toContain("windowId");
  });
});

describe("isReadableOpenWindowsManifest", () => {
  it("accepts a manifest that legitimately names zero windows", () => {
    // Closing every window persists exactly this. It must stay distinguishable
    // from having no manifest, or the next launch falls back to the global
    // last-active project.
    expect(isReadableOpenWindowsManifest(manifestJson([]))).toBe(true);
  });

  it("accepts a populated manifest", () => {
    expect(isReadableOpenWindowsManifest(manifestJson([{ projectId: "a" }]))).toBe(true);
  });

  it("accepts a manifest of picker windows", () => {
    expect(isReadableOpenWindowsManifest(manifestJson([{ projectId: null }]))).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
  ])("rejects %s", (_label, raw) => {
    expect(isReadableOpenWindowsManifest(raw)).toBe(false);
  });

  it("rejects a version it cannot read", () => {
    const future = JSON.stringify({
      version: OPEN_WINDOWS_MANIFEST_VERSION + 1,
      windows: [],
    });
    expect(isReadableOpenWindowsManifest(future)).toBe(false);
  });

  it("rejects a manifest whose windows is not an array", () => {
    expect(isReadableOpenWindowsManifest(manifestJson([]).replace("[]", "{}"))).toBe(false);
  });

  it("rejects a non-empty manifest whose every entry is malformed", () => {
    // Corrupt, not empty — the friendlier answer to corruption is the old
    // single-window behaviour rather than a bare project picker.
    expect(isReadableOpenWindowsManifest(manifestJson([{ projectId: 42 }, "junk"]))).toBe(false);
  });

  it("accepts a manifest where only some entries are malformed", () => {
    expect(
      isReadableOpenWindowsManifest(manifestJson([{ projectId: 42 }, { projectId: "a" }]))
    ).toBe(true);
  });
});

describe("filterRestorableWindows", () => {
  it("drops a record whose project no longer exists", () => {
    const records = [record("gone"), record("here")];
    expect(filterRestorableWindows(records, new Set(["here"]))).toEqual([record("here")]);
  });

  it("never substitutes a surviving project for a deleted one", () => {
    const filtered = filterRestorableWindows([record("gone")], new Set(["other"]));
    expect(filtered).toEqual([]);
  });

  it("keeps project-picker windows, which have no project to validate", () => {
    expect(filterRestorableWindows([record(null)], new Set())).toEqual([record(null)]);
  });

  it("lets the surviving windows through when one project is missing", () => {
    const records = [record("a"), record("gone"), record(null), record("b")];
    expect(filterRestorableWindows(records, new Set(["a", "b"]))).toEqual([
      record("a"),
      record(null),
      record("b"),
    ]);
  });

  it("keeps both windows when a duplicated project still exists", () => {
    expect(filterRestorableWindows([record("a"), record("a")], new Set(["a"]))).toHaveLength(2);
  });
});

describe("background project ids (#12320)", () => {
  const withBg = (projectId: string | null, backgroundProjectIds: string[]): OpenWindowRecord => ({
    projectId,
    backgroundProjectIds,
  });

  it("round-trips a background list", () => {
    const records = [withBg("alpha", ["beta", "gamma"]), record("delta")];
    expect(parseOpenWindowsManifest(serializeOpenWindowsManifest(records))).toEqual(records);
  });

  it("preserves background order — order is the recency signal", () => {
    const parsed = parseOpenWindowsManifest(
      serializeOpenWindowsManifest([withBg("a", ["z", "m", "b"])])
    );
    expect(parsed[0].backgroundProjectIds).toEqual(["z", "m", "b"]);
  });

  it("reads a manifest written before the field as a window with no background projects", () => {
    // The field was added without a version bump precisely so this holds: a
    // bump would make every stored manifest unreadable and cost users the
    // fleet the feature exists to restore.
    const parsed = parseOpenWindowsManifest(manifestJson([{ projectId: "alpha" }]));
    expect(parsed).toEqual([{ projectId: "alpha" }]);
    expect(parsed[0]).not.toHaveProperty("backgroundProjectIds");
  });

  it("omits an empty list when serializing, so the pre-#12320 shape is unchanged", () => {
    expect(serializeOpenWindowsManifest([withBg("alpha", [])])).toBe(
      serializeOpenWindowsManifest([record("alpha")])
    );
  });

  it.each([
    ["a string", "beta"],
    ["an object", { beta: true }],
    ["a number", 7],
    ["null", null],
  ])("keeps the window when its background field is %s", (_label, backgroundProjectIds) => {
    // Losing the window is worse than losing which extra projects it had.
    const parsed = parseOpenWindowsManifest(
      manifestJson([{ projectId: "alpha", backgroundProjectIds }])
    );
    expect(parsed).toEqual([{ projectId: "alpha" }]);
  });

  it("drops malformed entries but keeps the well-formed ones", () => {
    const parsed = parseOpenWindowsManifest(
      manifestJson([{ projectId: "alpha", backgroundProjectIds: ["beta", "", 3, null, "gamma"] }])
    );
    expect(parsed[0].backgroundProjectIds).toEqual(["beta", "gamma"]);
  });

  it("deduplicates", () => {
    const parsed = parseOpenWindowsManifest(
      manifestJson([{ projectId: "alpha", backgroundProjectIds: ["beta", "beta", "gamma"] }])
    );
    expect(parsed[0].backgroundProjectIds).toEqual(["beta", "gamma"]);
  });

  it("never lets a window list its own foreground project", () => {
    // A second view for the workspace the manager already has would sit in the
    // cache doing nothing but occupying a slot a real project needed.
    const parsed = parseOpenWindowsManifest(
      manifestJson([{ projectId: "alpha", backgroundProjectIds: ["alpha", "beta"] }])
    );
    expect(parsed[0].backgroundProjectIds).toEqual(["beta"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_BACKGROUND_PROJECTS_PER_WINDOW + 5 }, (_v, i) => `p${i}`);
    const parsed = parseOpenWindowsManifest(
      manifestJson([{ projectId: "alpha", backgroundProjectIds: many }])
    );
    expect(parsed[0].backgroundProjectIds).toHaveLength(MAX_BACKGROUND_PROJECTS_PER_WINDOW);
  });

  it("reads as readable — a background list is not corruption", () => {
    expect(
      isReadableOpenWindowsManifest(
        manifestJson([{ projectId: "alpha", backgroundProjectIds: ["beta"] }])
      )
    ).toBe(true);
  });
});

describe("filterRestorableWindows with background projects (#12320)", () => {
  it("drops deleted background workspaces and keeps the window", () => {
    const filtered = filterRestorableWindows(
      [{ projectId: "alpha", backgroundProjectIds: ["gone", "beta"] }],
      new Set(["alpha", "beta"])
    );
    expect(filtered).toEqual([{ projectId: "alpha", backgroundProjectIds: ["beta"] }]);
  });

  it("removes the field entirely when every background workspace is gone", () => {
    const filtered = filterRestorableWindows(
      [{ projectId: "alpha", backgroundProjectIds: ["gone", "also-gone"] }],
      new Set(["alpha"])
    );
    expect(filtered).toEqual([{ projectId: "alpha" }]);
  });

  it("still drops the window when its own project is gone", () => {
    expect(
      filterRestorableWindows(
        [{ projectId: "gone", backgroundProjectIds: ["beta"] }],
        new Set(["beta"])
      )
    ).toEqual([]);
  });

  it("keeps a picker window's surviving background projects", () => {
    expect(
      filterRestorableWindows(
        [{ projectId: null, backgroundProjectIds: ["beta"] }],
        new Set(["beta"])
      )
    ).toEqual([{ projectId: null, backgroundProjectIds: ["beta"] }]);
  });
});
