import { describe, expect, it } from "vitest";
import {
  PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON,
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_FEATURES,
  buildPresentationWhenContext,
  hasProjectToolbarOverrides,
  isProjectToolbarActive,
  isToolbarPresentationFeature,
  defaultPresentationLevel,
  isLevelAllowed,
  isPresentationFeatureAvailable,
  isPresentationFeatureId,
  parsePresentationLevels,
  resolvePresentation,
} from "../presentationProfile.js";
import type { ToolbarButtonId } from "../../types/toolbar.js";

describe("presentation profile vocabulary", () => {
  it("gives every feature a shown level and a unique camelCase context key", () => {
    const keys = new Set<string>();
    for (const id of PRESENTATION_FEATURE_IDS) {
      const feature = PRESENTATION_FEATURES[id];
      expect(feature.levels).toContain("shown");
      // camelCase with no dot: a plugin's keys sit under its lowercase manifest
      // name, so a built-in key shaped like this can never shadow one.
      expect(feature.contextKey).toMatch(/^[a-z]+(?:[A-Z][a-z0-9]*)+$/);
      keys.add(feature.contextKey);
    }
    expect(keys.size).toBe(PRESENTATION_FEATURE_IDS.length);
  });

  it("does not answer for inherited object keys", () => {
    expect(isPresentationFeatureId("forgeStats")).toBe(true);
    expect(isPresentationFeatureId("toString")).toBe(false);
    expect(isPresentationFeatureId("__proto__")).toBe(false);
    expect(isLevelAllowed("forgeStats", "demoted")).toBe(true);
    expect(isLevelAllowed("forgeStats", "collapsed")).toBe(false);
    // Git detail can be quieted but never hidden.
    expect(isLevelAllowed("gitDetail", "demoted")).toBe(true);
    expect(isLevelAllowed("gitDetail", "hidden")).toBe(false);
    expect(parsePresentationLevels({ gitDetail: "hidden" })).toEqual({});
  });
});

describe("parsePresentationLevels", () => {
  it("keeps known features at levels they offer and drops the rest per entry", () => {
    expect(
      parsePresentationLevels({
        forgeStats: "hidden",
        launcherBands: "hidden",
        agentState: "hidden",
      })
    ).toEqual({ forgeStats: "hidden" });
    expect(parsePresentationLevels({ forgeStats: "gone" })).toEqual({});
    expect(parsePresentationLevels({ forgeStats: true })).toEqual({});
  });

  it("reads anything that is not a plain object as no levels", () => {
    expect(parsePresentationLevels(null)).toEqual({});
    expect(parsePresentationLevels(["forgeStats"])).toEqual({});
    expect(parsePresentationLevels("forgeStats")).toEqual({});
  });
});

describe("resolvePresentation", () => {
  it("keeps today's behaviour as the defaults: a non-git folder hides forge stats", () => {
    expect(defaultPresentationLevel("forgeStats", { gitBacked: true })).toBe("shown");
    expect(defaultPresentationLevel("forgeStats", { gitBacked: false })).toBe("hidden");
    expect(resolvePresentation({}, { gitBacked: true }).forgeStats).toBe("shown");
    expect(resolvePresentation({}, { gitBacked: false }).forgeStats).toBe("hidden");
    expect(resolvePresentation({}, { gitBacked: true }).gitDetail).toBe("shown");
    expect(resolvePresentation({}, { gitBacked: false }).gitDetail).toBe("hidden");
  });

  it("lets a set level win over the default", () => {
    const resolved = resolvePresentation({ forgeStats: "demoted" }, { gitBacked: true });
    expect(resolved.forgeStats).toBe("demoted");
    expect(resolved.gitDetail).toBe("shown");
  });

  it("hides a repository surface in a folder without one, whatever level is set", () => {
    // An explicit "shown" must not mount a pill that polls git in a non-repo.
    expect(isPresentationFeatureAvailable("forgeStats", { gitBacked: false })).toBe(false);
    expect(resolvePresentation({ forgeStats: "shown" }, { gitBacked: false }).forgeStats).toBe(
      "hidden"
    );
    expect(resolvePresentation({ branchChip: "shown" }, { gitBacked: false }).branchChip).toBe(
      "hidden"
    );
    expect(resolvePresentation({ gitDetail: "demoted" }, { gitBacked: false }).gitDetail).toBe(
      "hidden"
    );
  });

  it("draws every toolbar feature at its default while the project's toolbar is off", () => {
    const levels = { copyTree: "demoted", forgeStats: "hidden", gitDetail: "demoted" } as const;
    const on = resolvePresentation(levels, { gitBacked: true });
    expect(on.copyTree).toBe("demoted");
    expect(on.forgeStats).toBe("hidden");
    const off = resolvePresentation(levels, { gitBacked: true }, { toolbar: false });
    expect(off.copyTree).toBe("shown");
    expect(off.forgeStats).toBe("shown");
    // Git detail lives on worktree cards, not the toolbar, so the toggle leaves it alone.
    expect(off.gitDetail).toBe("demoted");
  });
});

describe("toolbar features (#13783)", () => {
  // The never-demotable buttons that hold a toolbar id; the app menu, memory
  // pause and the overflow trigger never had one to map.
  const NEVER_DEMOTABLE: ToolbarButtonId[] = [
    "sidebar-toggle",
    "assistant-toggle",
    "portal-toggle",
    "voice-recording",
    "problems",
    "notification-center",
    "canopy",
    "settings",
    "launcher",
    "plugin-tray",
  ];

  it("maps no feature onto a button that must stay on the toolbar", () => {
    for (const id of NEVER_DEMOTABLE) {
      expect(PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON.has(id)).toBe(false);
    }
  });

  it("gives each toolbar button to exactly one feature, which follows the toolbar toggle", () => {
    // Read from the definitions, not the derived map, where a duplicate would
    // already have overwritten the first.
    const buttons = PRESENTATION_FEATURE_IDS.flatMap((id) => {
      const toolbar = (PRESENTATION_FEATURES[id] as { toolbar?: string | true }).toolbar;
      return typeof toolbar === "string" ? [toolbar] : [];
    });
    expect(new Set(buttons).size).toBe(buttons.length);
    for (const feature of PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON.values()) {
      expect(isToolbarPresentationFeature(feature)).toBe(true);
    }
    expect(isToolbarPresentationFeature("branchChip")).toBe(true);
  });

  it("only demotes the new toolbar items, never hides them", () => {
    for (const id of PRESENTATION_FEATURE_IDS) {
      if (id === "forgeStats" || !isToolbarPresentationFeature(id)) continue;
      expect(isLevelAllowed(id, "demoted")).toBe(true);
      expect(isLevelAllowed(id, "hidden")).toBe(false);
    }
    expect(parsePresentationLevels({ copyTree: "hidden", terminal: "demoted" })).toEqual({
      terminal: "demoted",
    });
  });

  it("turns the project's toolbar on by itself only once the profile places something", () => {
    const none = { levels: {}, useProjectToolbar: null, promotedPluginButtons: [] };
    expect(hasProjectToolbarOverrides(none)).toBe(false);
    expect(isProjectToolbarActive(none)).toBe(false);
    expect(isProjectToolbarActive({ ...none, levels: { devServer: "demoted" } })).toBe(true);
    expect(isProjectToolbarActive({ ...none, promotedPluginButtons: ["x"] })).toBe(true);
    // An explicit choice wins either way.
    expect(isProjectToolbarActive({ ...none, useProjectToolbar: true })).toBe(true);
    expect(
      isProjectToolbarActive({
        ...none,
        levels: { devServer: "demoted" },
        useProjectToolbar: false,
      })
    ).toBe(false);
  });
});

describe("buildPresentationWhenContext", () => {
  it("publishes each resolved level under its feature's context key", () => {
    const context = buildPresentationWhenContext(
      resolvePresentation(
        { forgeStats: "demoted", devServer: "demoted", gitDetail: "demoted" },
        { gitBacked: true }
      )
    );
    expect(context.presentationForgeStats).toBe("demoted");
    expect(context.presentationDevServer).toBe("demoted");
    expect(context.presentationCopyTree).toBe("shown");
    expect(context.presentationGitDetail).toBe("demoted");
  });
});
