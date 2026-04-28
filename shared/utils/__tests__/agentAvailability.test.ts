import { describe, it, expect } from "vitest";
import {
  isAgentReady,
  isAgentInstalled,
  isAgentMissing,
  isAgentBlocked,
  isAgentUnauthenticated,
  isAgentLaunchable,
} from "../agentAvailability.js";

const ALL_STATES = ["missing", "installed", "ready", "blocked", "unauthenticated"] as const;

describe("isAgentReady", () => {
  it("returns true only for ready", () => {
    expect(isAgentReady("ready")).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== "ready") expect(isAgentReady(s)).toBe(false);
    }
    expect(isAgentReady(undefined)).toBe(false);
  });
});

describe("isAgentInstalled", () => {
  it("returns true for installed, ready, blocked, and unauthenticated", () => {
    expect(isAgentInstalled("installed")).toBe(true);
    expect(isAgentInstalled("ready")).toBe(true);
    expect(isAgentInstalled("blocked")).toBe(true);
    expect(isAgentInstalled("unauthenticated")).toBe(true);
    expect(isAgentInstalled("missing")).toBe(false);
    expect(isAgentInstalled(undefined)).toBe(false);
  });
});

describe("isAgentMissing", () => {
  it("returns true only for missing or undefined", () => {
    expect(isAgentMissing("missing")).toBe(true);
    expect(isAgentMissing(undefined)).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== "missing") expect(isAgentMissing(s)).toBe(false);
    }
  });
});

describe("isAgentBlocked", () => {
  it("returns true only for blocked", () => {
    expect(isAgentBlocked("blocked")).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== "blocked") expect(isAgentBlocked(s)).toBe(false);
    }
    expect(isAgentBlocked(undefined)).toBe(false);
  });
});

describe("isAgentUnauthenticated", () => {
  it("returns true only for unauthenticated", () => {
    expect(isAgentUnauthenticated("unauthenticated")).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== "unauthenticated") expect(isAgentUnauthenticated(s)).toBe(false);
    }
    expect(isAgentUnauthenticated(undefined)).toBe(false);
  });
});

describe("isAgentLaunchable", () => {
  it("returns true for ready and unauthenticated", () => {
    expect(isAgentLaunchable("ready")).toBe(true);
    expect(isAgentLaunchable("unauthenticated")).toBe(true);
    expect(isAgentLaunchable("installed")).toBe(false);
    expect(isAgentLaunchable("blocked")).toBe(false);
    expect(isAgentLaunchable("missing")).toBe(false);
    expect(isAgentLaunchable(undefined)).toBe(false);
  });
});
