import { describe, expect, it } from "vitest";
import { isAgentPinned, isAgentPinnedById } from "../agentPinned.js";

describe("isAgentPinned — opt-in semantics", () => {
  it("returns false for undefined entry", () => {
    expect(isAgentPinned(undefined)).toBe(false);
  });

  it("returns false for null entry", () => {
    expect(isAgentPinned(null)).toBe(false);
  });

  it("returns false for empty entry", () => {
    expect(isAgentPinned({})).toBe(false);
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

  it("ignores other fields and reads pinned only", () => {
    expect(isAgentPinned({ customFlags: "--verbose", dangerousEnabled: true })).toBe(false);
    expect(isAgentPinned({ pinned: true, customFlags: "--verbose" })).toBe(true);
  });
});

describe("isAgentPinnedById", () => {
  it("returns false when settings is null", () => {
    expect(isAgentPinnedById(null, "claude")).toBe(false);
  });

  it("returns false when settings is undefined", () => {
    expect(isAgentPinnedById(undefined, "claude")).toBe(false);
  });

  it("returns false when agent entry is missing", () => {
    expect(isAgentPinnedById({ agents: {} }, "claude")).toBe(false);
  });

  it("returns true when the agent entry is explicitly pinned", () => {
    expect(isAgentPinnedById({ agents: { claude: { pinned: true } } }, "claude")).toBe(true);
  });

  it("returns false when the agent entry is explicitly unpinned", () => {
    expect(isAgentPinnedById({ agents: { claude: { pinned: false } } }, "claude")).toBe(false);
  });
});
