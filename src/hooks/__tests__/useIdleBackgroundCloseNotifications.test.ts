import { describe, expect, it } from "vitest";
import { formatProjectNames } from "../useIdleBackgroundCloseNotifications";

describe("formatProjectNames", () => {
  it.each([
    [["Alpha"], '"Alpha"'],
    [["Alpha", "Beta"], '"Alpha" and "Beta"'],
    [["Alpha", "Beta", "Gamma"], '"Alpha", "Beta" and "Gamma"'],
    [["A", "B", "C", "D"], '"A", "B", "C" and 1 other project'],
    [["A", "B", "C", "D", "E"], '"A", "B", "C" and 2 other projects'],
  ])("names %j as %s", (names, expected) => {
    expect(formatProjectNames(names)).toBe(expected);
  });
});
