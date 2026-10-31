import { describe, expect, it } from "vitest";
import { matchesTerminalLocationFilter } from "../terminalLocationFilter";

const PLACES = ["grid", "dock", "overlay", "trash", "background", undefined] as const;

function kept(filter: Parameters<typeof matchesTerminalLocationFilter>[1]) {
  return PLACES.filter((place) => matchesTerminalLocationFilter(place, filter));
}

describe("matchesTerminalLocationFilter (#15732)", () => {
  it("leaves the trash and the background out when no location is asked for", () => {
    expect(kept(undefined)).toEqual(["grid", "dock", "overlay", undefined]);
  });

  it("keeps only the one location asked for", () => {
    expect(kept("background")).toEqual(["background"]);
    expect(kept("trash")).toEqual(["trash"]);
    expect(kept("grid")).toEqual(["grid"]);
  });

  it("keeps every location for all", () => {
    expect(kept("all")).toEqual([...PLACES]);
  });
});
