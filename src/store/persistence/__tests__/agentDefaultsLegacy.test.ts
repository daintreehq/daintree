// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_AGENT_PREFERENCES_KEY,
  LEGACY_HELP_PANEL_KEY,
  LEGACY_TOOLBAR_PREFERENCES_KEY,
  clearLegacyAgentDefaults,
  readLegacyAgentDefaults,
} from "../agentDefaultsLegacy";
import { backupKeyFor } from "../safeStorage";

function put(key: string, state: unknown, version = 0): void {
  localStorage.setItem(key, JSON.stringify({ state, version }));
}

function stateOf(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && "state" in parsed
    ? parsed.state
    : undefined;
}

describe("legacy agent defaults (#13345)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("finds nothing on a machine that never chose either default", () => {
    expect(readLegacyAgentDefaults()).toEqual({});
  });

  it("reads the help panel's assistant agent", () => {
    put(LEGACY_HELP_PANEL_KEY, { width: 400, preferredAgentId: "claude" }, 6);
    expect(readLegacyAgentDefaults()).toEqual({ assistantAgentId: "claude" });
  });

  it("doesn't read the help panel's persisted null as a clear", () => {
    put(LEGACY_HELP_PANEL_KEY, { width: 400, preferredAgentId: null }, 6);
    expect(readLegacyAgentDefaults()).toEqual({});
  });

  it("offers no candidate for the retired assistant CLI", () => {
    put(LEGACY_HELP_PANEL_KEY, { width: 400, preferredAgentId: "daintree-assistant" }, 6);
    expect(readLegacyAgentDefaults()).toEqual({});
  });

  it("reads a saved default agent", () => {
    put(LEGACY_AGENT_PREFERENCES_KEY, { defaultAgent: "codex" });
    expect(readLegacyAgentDefaults()).toEqual({ defaultAgent: "codex" });
  });

  it("reads a saved-then-cleared default agent as an explicit clear", () => {
    put(LEGACY_AGENT_PREFERENCES_KEY, {});
    put(LEGACY_TOOLBAR_PREFERENCES_KEY, { launcher: { defaultAgent: "gemini" } });
    expect(readLegacyAgentDefaults()).toEqual({ defaultAgent: null });
  });

  it("falls back to the toolbar's older copy only when the preferences key never existed", () => {
    put(LEGACY_TOOLBAR_PREFERENCES_KEY, { launcher: { defaultAgent: "gemini" } });
    expect(readLegacyAgentDefaults()).toEqual({ defaultAgent: "gemini" });
  });

  it("recovers from the backup when the live blob is corrupt", () => {
    localStorage.setItem(LEGACY_HELP_PANEL_KEY, "{not-json");
    localStorage.setItem(
      backupKeyFor(LEGACY_HELP_PANEL_KEY),
      JSON.stringify({ state: { preferredAgentId: "codex" }, version: 6 })
    );
    expect(readLegacyAgentDefaults()).toEqual({ assistantAgentId: "codex" });
  });

  it("offers no candidate when both copies are unreadable", () => {
    localStorage.setItem(LEGACY_AGENT_PREFERENCES_KEY, "{not-json");
    expect(readLegacyAgentDefaults()).toEqual({});
  });

  it("clears every legacy copy of what the host confirmed, leaving the rest of each blob intact", () => {
    put(LEGACY_HELP_PANEL_KEY, { width: 412, preferredAgentId: "claude" }, 6);
    put(backupKeyFor(LEGACY_HELP_PANEL_KEY), { width: 412, preferredAgentId: "claude" }, 6);
    put(LEGACY_AGENT_PREFERENCES_KEY, { defaultAgent: "codex" });
    put(backupKeyFor(LEGACY_AGENT_PREFERENCES_KEY), { defaultAgent: "codex" });
    put(LEGACY_TOOLBAR_PREFERENCES_KEY, {
      launcher: { defaultAgent: "gemini", alwaysShowDevServer: true },
    });
    put(backupKeyFor(LEGACY_TOOLBAR_PREFERENCES_KEY), { launcher: { defaultAgent: "gemini" } });

    clearLegacyAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" });

    expect(readLegacyAgentDefaults()).toEqual({});
    expect(stateOf(LEGACY_HELP_PANEL_KEY)).toEqual({ width: 412 });
    expect(stateOf(backupKeyFor(LEGACY_HELP_PANEL_KEY))).toEqual({ width: 412 });
    expect(localStorage.getItem(LEGACY_AGENT_PREFERENCES_KEY)).toBeNull();
    expect(localStorage.getItem(backupKeyFor(LEGACY_AGENT_PREFERENCES_KEY))).toBeNull();
    expect(stateOf(LEGACY_TOOLBAR_PREFERENCES_KEY)).toEqual({
      launcher: { alwaysShowDevServer: true },
    });
    expect(stateOf(backupKeyFor(LEGACY_TOOLBAR_PREFERENCES_KEY))).toEqual({ launcher: {} });
  });

  it("keeps the source of a default the host didn't confirm holding", () => {
    put(LEGACY_HELP_PANEL_KEY, { width: 412, preferredAgentId: "claude" }, 6);
    put(LEGACY_AGENT_PREFERENCES_KEY, { defaultAgent: "codex" });

    clearLegacyAgentDefaults({ defaultAgent: null });

    expect(readLegacyAgentDefaults()).toEqual({ assistantAgentId: "claude" });
    expect(localStorage.getItem(LEGACY_AGENT_PREFERENCES_KEY)).toBeNull();
  });

  it("treats a localStorage that throws as having nothing, and never throws itself", () => {
    put(LEGACY_HELP_PANEL_KEY, { preferredAgentId: "claude" }, 6);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readLegacyAgentDefaults()).toEqual({});
    expect(() =>
      clearLegacyAgentDefaults({ assistantAgentId: "claude", defaultAgent: "codex" })
    ).not.toThrow();
  });

  it("leaves a corrupt blob for its own store's recovery to handle", () => {
    localStorage.setItem(LEGACY_HELP_PANEL_KEY, "{not-json");
    clearLegacyAgentDefaults({ assistantAgentId: "claude" });
    expect(localStorage.getItem(LEGACY_HELP_PANEL_KEY)).toBe("{not-json");
  });
});
