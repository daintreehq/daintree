// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { matchesResultFilter } from "../ForgeAuditLogViewer";
import { projectPluginStatus } from "../ProjectPluginsTab";
import type { ForgeAuditResult } from "@shared/types/ipc/forge";
import type { ProjectPluginInfo, ProjectPluginState } from "@shared/types/plugin";

const RESULTS: ForgeAuditResult[] = ["success", "not-found", "error"];
const STATES: ProjectPluginState[] = ["active", "staged", "blocked", "invalid"];

function plugin(state: ProjectPluginState, muted = false): ProjectPluginInfo {
  return { id: "acme.x", state, muted } as unknown as ProjectPluginInfo;
}

describe("forge audit result filter", () => {
  it("'All results' hides nothing", () => {
    for (const result of RESULTS) expect(matchesResultFilter("all", result)).toBe(true);
  });

  it("'Problems' is everything except success", () => {
    for (const result of RESULTS) {
      expect(matchesResultFilter("problems", result)).toBe(result !== "success");
    }
  });

  it("a single-result filter matches only its own result", () => {
    for (const filter of RESULTS) {
      for (const result of RESULTS) {
        expect(matchesResultFilter(filter, result)).toBe(filter === result);
      }
    }
  });
});

describe("project plugin status", () => {
  it("never claims a plugin runs while its folder is turned off", () => {
    for (const state of STATES) {
      if (state === "invalid") continue;
      for (const muted of [false, true]) {
        const status = projectPluginStatus(plugin(state, muted), false);
        expect(status).toBe(projectPluginStatus(plugin("blocked"), true));
      }
    }
  });

  it("a muted plugin reads the same as a folder-off one", () => {
    for (const state of STATES) {
      if (state === "invalid") continue;
      expect(projectPluginStatus(plugin(state, true), true)).toBe(
        projectPluginStatus(plugin(state), false)
      );
    }
  });

  it("an unreadable manifest says so whatever the folder or switch", () => {
    const unreadable = projectPluginStatus(plugin("invalid"), true);
    for (const trusted of [true, false]) {
      for (const muted of [true, false]) {
        expect(projectPluginStatus(plugin("invalid", muted), trusted)).toBe(unreadable);
      }
    }
    for (const state of STATES) {
      if (state === "invalid") continue;
      expect(projectPluginStatus(plugin(state), true)).not.toBe(unreadable);
    }
  });

  it("with the folder on, running and staged plugins are told apart", () => {
    expect(projectPluginStatus(plugin("active"), true)).not.toBe(
      projectPluginStatus(plugin("staged"), true)
    );
  });
});
