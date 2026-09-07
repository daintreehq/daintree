import { describe, it, expect, vi } from "vitest";

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: (id: string) => id === "marked-help" }),
}));

import { isAssistantTerminalRecord } from "../assistantTerminal.js";

describe("isAssistantTerminalRecord", () => {
  it("recognises the spawn-time record stamp", () => {
    expect(isAssistantTerminalRecord({ id: "t1", isAssistantTerminal: true })).toBe(true);
  });

  it("falls back to the renderer's availability-store mark", () => {
    // Covers records with no stamp — one adopted across a pty-host restart,
    // say — where the renderer's `help.markTerminal` is the only signal.
    expect(isAssistantTerminalRecord({ id: "marked-help" })).toBe(true);
  });

  it("treats an ordinary agent pane as adoptable and journalable", () => {
    expect(isAssistantTerminalRecord({ id: "t1" })).toBe(false);
    expect(isAssistantTerminalRecord({ id: "t1", isAssistantTerminal: false })).toBe(false);
  });

  it("fails open when the availability store is unusable", async () => {
    // This predicate runs inside the shutdown and project-teardown journal
    // loops, which wrap their work in best-effort catches. A throw here would
    // be swallowed as "journal nothing at all" and cost every terminal its
    // resume record — so an unavailable store must degrade to one stray
    // assistant record, never to a silent loss of all of them.
    vi.resetModules();
    vi.doMock("../AgentAvailabilityStore.js", () => ({
      getAgentAvailabilityStore: () => {
        throw new Error("store not initialised");
      },
    }));
    const { isAssistantTerminalRecord: predicate } = await import("../assistantTerminal.js");

    expect(predicate({ id: "t1" })).toBe(false);
    // The record stamp is checked first, so it survives the store being gone.
    expect(predicate({ id: "t1", isAssistantTerminal: true })).toBe(true);

    vi.doUnmock("../AgentAvailabilityStore.js");
    vi.resetModules();
  });

  it("answers false for a missing record rather than throwing", () => {
    // The teardown paths look records up in a pre-kill snapshot that can miss.
    expect(isAssistantTerminalRecord(undefined)).toBe(false);
    expect(isAssistantTerminalRecord(null)).toBe(false);
  });
});
