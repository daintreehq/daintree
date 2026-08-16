import { describe, it, expect } from "vitest";
import { canSleepProject } from "../ProjectSwitcherPalette";

describe("canSleepProject", () => {
  it("offers Sleep for the project on screen", () => {
    // The point of #11802: "Free memory", which this replaces, hid itself for
    // the active project, leaving the one you're looking at with no way to shut
    // down short of destroying its layout.
    expect(canSleepProject({ isMissing: false, status: "active" })).toBe(true);
  });

  it("offers Sleep for a background project", () => {
    expect(canSleepProject({ isMissing: false, status: "background" })).toBe(true);
  });

  it("hides Sleep for a project that is already asleep", () => {
    // Better than the silent no-op the old action gave a closed project.
    expect(canSleepProject({ isMissing: false, status: "closed" })).toBe(false);
  });

  it("hides Sleep for a missing project", () => {
    // Nothing is loaded to shut down, whatever its last-known status was.
    expect(canSleepProject({ isMissing: true, status: "background" })).toBe(false);
    expect(canSleepProject({ isMissing: true, status: "active" })).toBe(false);
  });

  it("offers Sleep when the status is unknown", () => {
    // A row with no status is not proof the project is shut, and refusing on
    // that basis would silently strip the action off a live project.
    expect(canSleepProject({ isMissing: false })).toBe(true);
  });
});
