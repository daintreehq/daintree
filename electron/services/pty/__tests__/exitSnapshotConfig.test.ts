import { afterEach, describe, expect, it } from "vitest";
import {
  setExitSnapshotEnabled,
  setExitSnapshotExcludedProjects,
  shouldCaptureExitSnapshot,
  _resetExitSnapshotConfig,
} from "../exitSnapshotConfig.js";

afterEach(() => {
  _resetExitSnapshotConfig();
});

describe("shouldCaptureExitSnapshot", () => {
  it("is off by default (no capture even for agent terminals)", () => {
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p1" })).toBe(false);
  });

  it("never captures for non-agent terminals even when enabled", () => {
    setExitSnapshotEnabled(true);
    expect(shouldCaptureExitSnapshot({ launchAgentId: undefined, projectId: "p1" })).toBe(false);
  });

  it("captures for an agent terminal when enabled and project not excluded", () => {
    setExitSnapshotEnabled(true);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p1" })).toBe(true);
  });

  it("honors the per-project exclusion even when globally enabled", () => {
    setExitSnapshotEnabled(true);
    setExitSnapshotExcludedProjects(["p1", "p2"]);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p1" })).toBe(false);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p3" })).toBe(true);
  });

  it("treats a null/absent project id as not excluded", () => {
    setExitSnapshotEnabled(true);
    setExitSnapshotExcludedProjects(["p1"]);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: null })).toBe(true);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: undefined })).toBe(true);
  });

  it("replaces the excluded set on each call (full-set semantics, not deltas)", () => {
    setExitSnapshotEnabled(true);
    setExitSnapshotExcludedProjects(["p1"]);
    setExitSnapshotExcludedProjects(["p2"]);
    // p1 is no longer excluded after the replacement.
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p1" })).toBe(true);
    expect(shouldCaptureExitSnapshot({ launchAgentId: "claude", projectId: "p2" })).toBe(false);
  });
});
