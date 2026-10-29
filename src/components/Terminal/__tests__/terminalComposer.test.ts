import { describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { panelHasComposer } from "../terminalComposer";

function pane(fields: Record<string, unknown>): PanelInstance {
  return {
    id: "p1",
    title: "Pane",
    location: "grid",
    kind: "terminal",
    ...fields,
  } as PanelInstance;
}

const ON = { hybridInputEnabled: true, isFleetArmed: false, fleetSize: 0 };

describe("panelHasComposer (#14955)", () => {
  it.each([
    ["launched as an agent", { launchAgentId: "claude" }],
    ["running a detected agent", { detectedAgentId: "codex" }],
    [
      "holding an agent runtime identity",
      { runtimeIdentity: { kind: "agent", agentId: "claude" } },
    ],
  ])("is true for a pane %s", (_n, fields) => {
    expect(panelHasComposer(pane(fields), ON)).toBe(true);
  });

  it("is false once the agent a pane was launched with has exited to its shell", () => {
    expect(panelHasComposer(pane({ launchAgentId: "claude", agentState: "exited" }), ON)).toBe(
      false
    );
  });

  it("is false for an agent pane while hybrid input is off", () => {
    expect(
      panelHasComposer(pane({ launchAgentId: "claude" }), { ...ON, hybridInputEnabled: false })
    ).toBe(false);
  });

  it("gives a plain shell a composer only while it is armed in a fleet of two or more", () => {
    const shell = pane({});
    expect(panelHasComposer(shell, ON)).toBe(false);
    expect(panelHasComposer(shell, { ...ON, isFleetArmed: true, fleetSize: 1 })).toBe(false);
    expect(panelHasComposer(shell, { ...ON, isFleetArmed: true, fleetSize: 2 })).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["trashed", pane({ launchAgentId: "claude", location: "trash" })],
    ["held for recovery", pane({ launchAgentId: "claude", restoreRecovery: { reason: "x" } })],
    ["a browser", pane({ kind: "browser" })],
  ])("is false for a pane that is %s", (_n, panel) => {
    expect(panelHasComposer(panel, { ...ON, isFleetArmed: true, fleetSize: 3 })).toBe(false);
  });
});
