import { describe, expect, it } from "vitest";
import type { PluginFilter, PluginFilterField } from "@shared/types/plugin-sdk-react";
import { matchesFilter, readFilter, readFilterFields } from "../filters";

const fields: PluginFilterField[] = [
  { id: "title", label: "Title", type: "text" },
  { id: "points", label: "Points", type: "number" },
  { id: "due", label: "Due", type: "date" },
  {
    id: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed", disabled: true },
    ],
  },
  { id: "owner", label: "Owner", type: "select", options: [{ value: "me", label: "Me" }] },
  { id: "archived", label: "Archived", type: "boolean" },
];

const where = (
  conditions: PluginFilter["conditions"],
  match: PluginFilter["match"] = "all"
): PluginFilter => ({ match, conditions });

describe("readFilterFields", () => {
  it("keeps usable fields in order and narrows comparisons to the type's", () => {
    const schema = readFilterFields([
      { id: "a", label: "A", type: "text", operators: ["contains", "gt", "eq"] },
      { id: "a", label: "Duplicate", type: "number" },
      { id: "", label: "Nameless", type: "text" },
      { id: "b", label: "B", type: "colour" },
      { id: "c", label: "C", type: "number", operators: ["contains"] },
      { id: "d", label: "D", type: "boolean" },
    ]);
    expect([...schema.keys()]).toEqual(["a", "d"]);
    expect(schema.get("a")?.operators).toEqual(["eq", "contains"]);
    expect(schema.get("d")?.operators).toEqual(["eq", "empty", "not_empty"]);
  });

  it("drops a field whose restriction leaves nothing rather than offering everything", () => {
    const schema = readFilterFields([{ id: "a", label: "A", type: "text", operators: [] }]);
    expect(schema.size).toBe(0);
  });
});

describe("readFilter", () => {
  it("copies a complete filter", () => {
    const filter = where([
      { field: "status", op: "eq", value: "open" },
      { field: "owner", op: "eq", value: "me" },
      { field: "due", op: "empty" },
    ]);
    const read = readFilter(filter, fields);
    expect(read).toEqual(filter);
    expect(read).not.toBe(filter);
    expect(read?.conditions[0]).not.toBe(filter.conditions[0]);
  });

  it("accepts a listed option that is disabled", () => {
    expect(
      readFilter(where([{ field: "status", op: "eq", value: "closed" }]), fields)
    ).not.toBeNull();
  });

  it.each([
    ["an unknown field", { field: "colour", op: "eq", value: "red" }],
    ["a comparison the type lacks", { field: "title", op: "gt", value: "a" }],
    ["a missing value", { field: "title", op: "eq" }],
    ["an empty text value", { field: "title", op: "eq", value: "" }],
    ["a value on a nullary comparison", { field: "title", op: "empty", value: "x" }],
    ["a numeric string", { field: "points", op: "gt", value: "3" }],
    ["a non-finite number", { field: "points", op: "gt", value: Number.POSITIVE_INFINITY }],
    ["an impossible day", { field: "due", op: "eq", value: "2026-02-30" }],
    ["a timestamp for a day", { field: "due", op: "eq", value: "2026-02-03T10:00:00Z" }],
    ["an option that is not listed", { field: "status", op: "eq", value: "archived" }],
    ["a string for a boolean", { field: "archived", op: "eq", value: "true" }],
    ["an unknown key", { field: "title", op: "eq", value: "a", not: true }],
    ["a nested group", { match: "all", conditions: [] }],
  ])("refuses %s rather than dropping it", (_, condition) => {
    const filter = {
      match: "all",
      conditions: [{ field: "status", op: "eq", value: "open" }, condition],
    };
    expect(readFilter(filter, fields)).toBeNull();
  });

  it("refuses a malformed root", () => {
    expect(readFilter(null, fields)).toBeNull();
    expect(readFilter({ match: "some", conditions: [] }, fields)).toBeNull();
    expect(readFilter({ match: "all" }, fields)).toBeNull();
    expect(readFilter({ match: "all", conditions: [], extra: 1 }, fields)).toBeNull();
  });

  it("refuses a restricted comparison", () => {
    const restricted: PluginFilterField[] = [
      { id: "title", label: "Title", type: "text", operators: ["contains"] },
    ];
    expect(readFilter(where([{ field: "title", op: "eq", value: "x" }]), restricted)).toBeNull();
  });

  it("reads a record's values as its own properties only", () => {
    const inherited: PluginFilterField[] = [{ id: "toString", label: "Name", type: "text" }];
    const filter = where([{ field: "toString", op: "not_empty" }]);
    expect(readFilter(filter, inherited)).toEqual(filter);
    expect(matchesFilter(filter, {}, inherited)).toBe(false);
    expect(matchesFilter(filter, { toString: "x" }, inherited)).toBe(true);
  });
});

describe("matchesFilter", () => {
  const record = {
    title: "Fix the Login page",
    points: 3,
    due: "2026-03-10",
    status: "open",
    owner: "me",
    archived: false,
  };
  const passes = (
    condition: PluginFilter["conditions"][number],
    values: Readonly<Record<string, unknown>> = record
  ) => matchesFilter(where([condition]), values, fields);

  it("matches everything with no conditions, in either mode", () => {
    expect(matchesFilter(where([]), {}, fields)).toBe(true);
    expect(matchesFilter(where([], "any"), {}, fields)).toBe(true);
  });

  it("finds Status is Open and Owner is me", () => {
    const filter = where([
      { field: "status", op: "eq", value: "open" },
      { field: "owner", op: "eq", value: "me" },
    ]);
    expect(matchesFilter(filter, record, fields)).toBe(true);
    expect(matchesFilter(filter, { ...record, owner: "ada" }, fields)).toBe(false);
    expect(matchesFilter({ ...filter, match: "any" }, { ...record, owner: "ada" }, fields)).toBe(
      true
    );
  });

  it("compares text exactly for eq and ignoring case for contains", () => {
    expect(passes({ field: "title", op: "eq", value: "Fix the Login page" })).toBe(true);
    expect(passes({ field: "title", op: "eq", value: "fix the login page" })).toBe(false);
    expect(passes({ field: "title", op: "neq", value: "Other" })).toBe(true);
    expect(passes({ field: "title", op: "contains", value: "login" })).toBe(true);
    expect(passes({ field: "title", op: "not_contains", value: "LOGIN" })).toBe(false);
  });

  it("compares numbers", () => {
    expect(passes({ field: "points", op: "eq", value: 3 })).toBe(true);
    expect(passes({ field: "points", op: "neq", value: 3 })).toBe(false);
    expect(passes({ field: "points", op: "gt", value: 2 })).toBe(true);
    expect(passes({ field: "points", op: "gte", value: 3 })).toBe(true);
    expect(passes({ field: "points", op: "lt", value: 3 })).toBe(false);
    expect(passes({ field: "points", op: "lte", value: 3 })).toBe(true);
    expect(passes({ field: "points", op: "eq", value: 3 }, { points: "3" })).toBe(false);
    expect(passes({ field: "points", op: "gt", value: 0 }, { points: Number.NaN })).toBe(false);
  });

  it("compares days, reading timestamps on the local day", () => {
    expect(passes({ field: "due", op: "eq", value: "2026-03-10" })).toBe(true);
    expect(passes({ field: "due", op: "before", value: "2026-03-11" })).toBe(true);
    expect(passes({ field: "due", op: "after", value: "2026-03-10" })).toBe(false);
    const noon = new Date(2026, 2, 10, 12).getTime();
    expect(passes({ field: "due", op: "eq", value: "2026-03-10" }, { due: noon })).toBe(true);
    expect(passes({ field: "due", op: "eq", value: "2026-03-10" }, { due: new Date(noon) })).toBe(
      true
    );
    expect(
      passes({ field: "due", op: "eq", value: "2026-03-10" }, { due: new Date(noon).toISOString() })
    ).toBe(true);
    expect(passes({ field: "due", op: "eq", value: "2026-03-10" }, { due: "soon" })).toBe(false);
  });

  it("compares booleans and options", () => {
    expect(passes({ field: "archived", op: "eq", value: false })).toBe(true);
    expect(passes({ field: "archived", op: "eq", value: true })).toBe(false);
    expect(passes({ field: "status", op: "neq", value: "open" })).toBe(false);
  });

  it("matches a missing value only with empty, as SQL would", () => {
    const unassigned = { ...record, owner: null };
    expect(passes({ field: "owner", op: "neq", value: "me" }, unassigned)).toBe(false);
    expect(passes({ field: "owner", op: "empty" }, unassigned)).toBe(true);
    expect(passes({ field: "owner", op: "not_empty" }, unassigned)).toBe(false);
    expect(passes({ field: "title", op: "empty" }, { title: "" })).toBe(true);
    expect(passes({ field: "points", op: "empty" }, { points: 0 })).toBe(false);
    expect(passes({ field: "archived", op: "empty" }, { archived: false })).toBe(false);
    expect(passes({ field: "title", op: "empty" }, { title: " " })).toBe(false);
  });

  it("matches nothing when any condition is invalid, even under any", () => {
    const filter = where(
      [
        { field: "status", op: "eq", value: "open" },
        { field: "status", op: "eq", value: "gone" },
      ],
      "any"
    );
    expect(matchesFilter(filter, record, fields)).toBe(false);
  });

  it("leaves its inputs untouched", () => {
    const filter = where([{ field: "title", op: "contains", value: "login" }]);
    const snapshot = JSON.stringify([filter, record, fields]);
    matchesFilter(filter, record, fields);
    readFilter(filter, fields);
    expect(JSON.stringify([filter, record, fields])).toBe(snapshot);
  });
});
