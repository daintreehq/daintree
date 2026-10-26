import { describe, expect, it } from "vitest";
import {
  isAgentButtonOnToolbar,
  isAgentPinned,
  isAgentPinnedById,
  isAgentToolbarVisible,
} from "../agentPinned.js";

describe("isAgentPinned — opt-in semantics", () => {
  it("returns false for an unset pin", () => {
    expect(isAgentPinned(undefined)).toBe(false);
  });

  it("returns true only when pinned is explicitly true", () => {
    expect(isAgentPinned(true)).toBe(true);
  });

  it("returns false when pinned is explicitly false", () => {
    expect(isAgentPinned(false)).toBe(false);
  });
});

describe("isAgentPinnedById", () => {
  it("returns false when there are no pins", () => {
    expect(isAgentPinnedById(null, "claude")).toBe(false);
    expect(isAgentPinnedById({}, "claude")).toBe(false);
  });

  it("returns true when the agent is explicitly pinned", () => {
    expect(isAgentPinnedById({ claude: true }, "claude")).toBe(true);
  });

  it("never reads an inherited property as a pin", () => {
    expect(isAgentPinnedById({}, "constructor")).toBe(false);
    expect(isAgentPinnedById({}, "toString")).toBe(false);
  });
});

describe("isAgentToolbarVisible — tri-state with availability fallback", () => {
  it("returns true when pinned is explicitly true regardless of availability", () => {
    expect(isAgentToolbarVisible(true, "ready")).toBe(true);
    expect(isAgentToolbarVisible(true, "installed")).toBe(true);
    expect(isAgentToolbarVisible(true, "missing")).toBe(true);
    expect(isAgentToolbarVisible(true, undefined)).toBe(true);
  });

  it("returns false when pinned is explicitly false regardless of availability", () => {
    expect(isAgentToolbarVisible(false, "ready")).toBe(false);
    expect(isAgentToolbarVisible(false, "installed")).toBe(false);
    expect(isAgentToolbarVisible(false, "missing")).toBe(false);
    expect(isAgentToolbarVisible(false, undefined)).toBe(false);
  });

  it("follows availability when unset (installed/ready/blocked/unauthenticated → visible)", () => {
    expect(isAgentToolbarVisible(undefined, "ready")).toBe(true);
    expect(isAgentToolbarVisible(undefined, "installed")).toBe(true);
    expect(isAgentToolbarVisible(undefined, "blocked")).toBe(true);
    expect(isAgentToolbarVisible(undefined, "unauthenticated")).toBe(true);
  });

  it("follows availability when unset (missing/undefined → hidden)", () => {
    expect(isAgentToolbarVisible(undefined, "missing")).toBe(false);
    expect(isAgentToolbarVisible(undefined, undefined)).toBe(false);
  });
});

describe("isAgentButtonOnToolbar — position-aware tri-state", () => {
  it("an explicit pin wins over position and availability", () => {
    expect(isAgentButtonOnToolbar(true, "missing", false)).toBe(true);
    expect(isAgentButtonOnToolbar(false, "ready", true)).toBe(false);
  });

  it("an unset pin needs both a position and an installed CLI", () => {
    expect(isAgentButtonOnToolbar(undefined, "ready", true)).toBe(true);
    expect(isAgentButtonOnToolbar(undefined, "ready", false)).toBe(false);
    expect(isAgentButtonOnToolbar(undefined, "missing", true)).toBe(false);
  });
});
