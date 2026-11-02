// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetHostPlatformForTests } from "@/hooks/useHostPlatform";
import { getSettingsNavGroups } from "../settingsTabRegistry";
import { isSettingsTabAvailable } from "../settingsTabAvailability";
import { PROJECT_SETTINGS_TAB_IDS } from "../settingsTabIds";

function projectNavIds(): string[] {
  return getSettingsNavGroups("project").flatMap((group) => group.entries.map((e) => e.id));
}

beforeEach(() => _resetHostPlatformForTests());

afterEach(() => {
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("Project settings → Schedules", () => {
  it("sits next to Recipes in a window on this machine's project", () => {
    const ids = projectNavIds();
    expect(ids).toContain("project:schedules");
    expect(ids.indexOf("project:schedules")).toBe(ids.indexOf("project:recipes") + 1);
    expect(isSettingsTabAvailable("project:schedules")).toBe(true);
  });

  it("is absent from a window driving a Remote Host's project, and nothing else is", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    _resetHostPlatformForTests();

    expect(isSettingsTabAvailable("project:schedules")).toBe(false);
    expect(projectNavIds()).toEqual(
      PROJECT_SETTINGS_TAB_IDS.filter((tab) => tab !== "project:schedules")
    );
  });
});
