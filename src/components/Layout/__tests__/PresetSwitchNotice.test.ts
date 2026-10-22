import { describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { isPaneLeftOnPreset } from "../PresetSwitchNotice";

const notice = { worktreeId: "wt-1", fromPresetId: "personal" };

const pane = (overrides: Record<string, unknown> = {}): PanelInstance =>
  ({
    id: "p1",
    kind: "terminal",
    title: "Codex [Personal]",
    cwd: "/repo",
    location: "grid",
    launchAgentId: "codex",
    worktreeId: "wt-1",
    agentPresetId: "personal",
    agentState: "waiting",
    ...overrides,
  }) as PanelInstance;

describe("isPaneLeftOnPreset (#13746)", () => {
  it("counts a live pane of the agent still on the preset the pick moved off", () => {
    expect(isPaneLeftOnPreset(pane(), "codex", notice)).toBe(true);
  });

  it("counts a preset-free pane when the pick moved off the agent default", () => {
    expect(
      isPaneLeftOnPreset(pane({ agentPresetId: undefined }), "codex", {
        worktreeId: "wt-1",
        fromPresetId: undefined,
      })
    ).toBe(true);
  });

  it.each([
    ["another agent", { launchAgentId: "claude" }],
    ["another worktree", { worktreeId: "wt-2" }],
    ["another preset", { agentPresetId: "work" }],
    ["a fallback, which has its own indicator", { isUsingFallback: true }],
    ["an exited agent", { agentState: "exited" }],
    ["a pane in the trash", { location: "trash" }],
    ["a pane held for recovery", { restoreRecovery: { reason: "session-unresolved" } }],
  ])("leaves out %s", (_label, overrides) => {
    expect(isPaneLeftOnPreset(pane(overrides), "codex", notice)).toBe(false);
  });
});
