import { describe, expect, it } from "vitest";
import {
  SESSION_OPEN_PROJECTS_VERSION,
  parseSessionOpenProjects,
  serializeSessionOpenProjects,
} from "../sessionOpenProjects.js";

/**
 * The corruption matrix for the session-open checkpoint (#11794). Pure — no DB,
 * no Electron — because every one of these shapes has to fail toward "the
 * previous session named nothing" rather than toward marking projects the user
 * never had open.
 */
describe("session-open checkpoint payload", () => {
  const store = (value: unknown) => JSON.stringify(value);

  describe("round trip", () => {
    it("recovers exactly the set it was given", () => {
      const ids = ["proj-b", "proj-a", "proj-c"];
      expect(new Set(parseSessionOpenProjects(serializeSessionOpenProjects(ids)))).toEqual(
        new Set(ids)
      );
    });

    it("survives far more projects than the window manifest would restore", () => {
      // The cap that is right for spawning windows is wrong for a decoration:
      // truncating here would silently under-report the set the dot describes.
      const ids = Array.from({ length: 50 }, (_, i) => `proj-${i}`);
      expect(parseSessionOpenProjects(serializeSessionOpenProjects(ids))).toHaveLength(50);
    });

    it("is byte-identical for the same set in a different order", () => {
      expect(serializeSessionOpenProjects(["b", "a"])).toBe(
        serializeSessionOpenProjects(["a", "b"])
      );
    });

    it("collapses duplicates on the way in and on the way out", () => {
      expect(serializeSessionOpenProjects(["a", "a", "b"])).toBe(
        serializeSessionOpenProjects(["a", "b"])
      );
      expect(
        parseSessionOpenProjects(
          store({ version: SESSION_OPEN_PROJECTS_VERSION, projectIds: ["a", "a"] })
        )
      ).toEqual(["a"]);
    });

    it("drops empty ids rather than storing an id that matches no row", () => {
      expect(parseSessionOpenProjects(serializeSessionOpenProjects(["a", ""]))).toEqual(["a"]);
    });
  });

  describe("unreadable input reads as an empty set", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an empty string", ""],
      ["invalid JSON", "{not json"],
      ["a bare array", '["a"]'],
      ["a JSON scalar", "42"],
      ["a JSON null", "null"],
    ])("%s", (_label, raw) => {
      expect(parseSessionOpenProjects(raw as string | null | undefined)).toEqual([]);
    });

    it("refuses a version this build does not know", () => {
      const future = store({ version: SESSION_OPEN_PROJECTS_VERSION + 1, projectIds: ["a"] });
      // A future shape is unreadable, not merely unsupported — guessing at its
      // fields is how you resurrect ids that mean something else.
      expect(parseSessionOpenProjects(future)).toEqual([]);
    });

    it("refuses a payload with no version at all", () => {
      expect(parseSessionOpenProjects(store({ projectIds: ["a"] }))).toEqual([]);
    });

    it("refuses a projectIds field that is not an array", () => {
      expect(
        parseSessionOpenProjects(store({ version: SESSION_OPEN_PROJECTS_VERSION, projectIds: "a" }))
      ).toEqual([]);
    });
  });

  describe("partial corruption", () => {
    it("keeps the valid ids and drops the malformed entries beside them", () => {
      const mixed = store({
        version: SESSION_OPEN_PROJECTS_VERSION,
        projectIds: ["good-a", 42, null, "", { id: "nope" }, ["nested"], "good-b"],
      });
      expect(parseSessionOpenProjects(mixed)).toEqual(["good-a", "good-b"]);
    });

    it("reads an all-malformed list as empty rather than inventing ids", () => {
      expect(
        parseSessionOpenProjects(
          store({ version: SESSION_OPEN_PROJECTS_VERSION, projectIds: [1, null, ""] })
        )
      ).toEqual([]);
    });

    it("ignores unknown fields inside a version it does recognize", () => {
      const extra = store({
        version: SESSION_OPEN_PROJECTS_VERSION,
        projectIds: ["a"],
        writtenAt: 123,
        windows: 4,
      });
      expect(parseSessionOpenProjects(extra)).toEqual(["a"]);
    });
  });

  it("stores an empty set as a readable checkpoint, not as absence", () => {
    // The session that closed everything has to be able to say so — otherwise
    // the previous session's ids would be indistinguishable from "cleared".
    const serialized = serializeSessionOpenProjects([]);
    expect(JSON.parse(serialized)).toEqual({
      version: SESSION_OPEN_PROJECTS_VERSION,
      projectIds: [],
    });
    expect(parseSessionOpenProjects(serialized)).toEqual([]);
  });
});
