import { describe, expect, it } from "vitest";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_FEATURES,
  buildPresentationWhenContext,
  defaultPresentationLevel,
  isLevelAllowed,
  isPresentationFeatureAvailable,
  isPresentationFeatureId,
  parsePresentationLevels,
  resolvePresentation,
} from "../presentationProfile.js";

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
    expect(resolvePresentation({}, { gitBacked: true })).toEqual({
      forgeStats: "shown",
      gitDetail: "shown",
    });
    expect(resolvePresentation({}, { gitBacked: false })).toEqual({
      forgeStats: "hidden",
      gitDetail: "hidden",
    });
  });

  it("lets a set level win over the default", () => {
    expect(resolvePresentation({ forgeStats: "demoted" }, { gitBacked: true })).toEqual({
      forgeStats: "demoted",
      gitDetail: "shown",
    });
  });

  it("hides a repository surface in a folder without one, whatever level is set", () => {
    // An explicit "shown" must not mount a pill that polls git in a non-repo.
    expect(isPresentationFeatureAvailable("forgeStats", { gitBacked: false })).toBe(false);
    expect(
      resolvePresentation({ forgeStats: "shown", gitDetail: "demoted" }, { gitBacked: false })
    ).toEqual({
      forgeStats: "hidden",
      gitDetail: "hidden",
    });
  });
});

describe("buildPresentationWhenContext", () => {
  it("publishes each resolved level under its feature's context key", () => {
    expect(buildPresentationWhenContext({ forgeStats: "demoted", gitDetail: "shown" })).toEqual({
      presentationForgeStats: "demoted",
      presentationGitDetail: "shown",
    });
  });
});
