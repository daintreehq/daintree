import { describe, expect, it } from "vitest";
import { isAgentPinned, isAgentPinnedById, isAgentToolbarVisible } from "../agentPinned.js";

describe("isAgentPinned — opt-in semantics", () => {
  it("returns false for undefined entry", () => {
    expect(isAgentPinned(undefined)).toBe(false);
  });

  it("returns false when pinned is undefined", () => {
    expect(isAgentPinned({ pinned: undefined })).toBe(false);
  });

  it("returns true only when pinned is explicitly true", () => {
    expect(isAgentPinned({ pinned: true })).toBe(true);
  });

  it("returns false when pinned is explicitly false", () => {
    expect(isAgentPinned({ pinned: false })).toBe(false);
  });
});

describe("isAgentPinnedById", () => {
  it("returns false when settings is null", () => {
    expect(isAgentPinnedById(null, "claude")).toBe(false);
  });

  it("returns true when the agent entry is explicitly pinned", () => {
    expect(isAgentPinnedById({ agents: { claude: { pinned: true } } }, "claude")).toBe(true);
  });
});

describe("isAgentToolbarVisible — tri-state with availability fallback", () => {
  it("returns true when pinned is explicitly true regardless of availability", () => {
    expect(isAgentToolbarVisible({ pinned: true }, "ready")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: true }, "installed")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: true }, "missing")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: true }, undefined)).toBe(true);
  });

  it("returns false when pinned is explicitly false regardless of availability", () => {
    expect(isAgentToolbarVisible({ pinned: false }, "ready")).toBe(false);
    expect(isAgentToolbarVisible({ pinned: false }, "installed")).toBe(false);
    expect(isAgentToolbarVisible({ pinned: false }, "missing")).toBe(false);
    expect(isAgentToolbarVisible({ pinned: false }, undefined)).toBe(false);
  });

  it("follows availability when pinned is undefined (installed/ready/blocked/unauthenticated → visible)", () => {
    expect(isAgentToolbarVisible({ pinned: undefined }, "ready")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: undefined }, "installed")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: undefined }, "blocked")).toBe(true);
    expect(isAgentToolbarVisible({ pinned: undefined }, "unauthenticated")).toBe(true);
  });

  it("follows availability when pinned is undefined (missing/undefined → hidden)", () => {
    expect(isAgentToolbarVisible({ pinned: undefined }, "missing")).toBe(false);
    expect(isAgentToolbarVisible({ pinned: undefined }, undefined)).toBe(false);
  });

  it("treats null/undefined entry as follows-availability (tri-state default)", () => {
    expect(isAgentToolbarVisible(undefined, "ready")).toBe(true);
    expect(isAgentToolbarVisible(undefined, "missing")).toBe(false);
    expect(isAgentToolbarVisible(null, "ready")).toBe(true);
    expect(isAgentToolbarVisible(null, undefined)).toBe(false);
  });
});
