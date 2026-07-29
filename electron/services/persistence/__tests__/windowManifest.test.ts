import { describe, it, expect } from "vitest";
import {
  MAX_RESTORED_WINDOWS,
  OPEN_WINDOWS_MANIFEST_VERSION,
  filterRestorableWindows,
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
