import { describe, it, expect } from "vitest";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
  STATE_ICONS,
  STATE_COLORS,
  STATE_LABELS,
} from "../terminalStateConfig";
import type { AgentState } from "@/types";

describe("getEffectiveStateIcon", () => {
  it("returns default icon for waiting", () => {
    expect(getEffectiveStateIcon("waiting")).toBe(STATE_ICONS.waiting);
  });

  it("returns default icon for non-waiting states", () => {
    expect(getEffectiveStateIcon("working")).toBe(STATE_ICONS.working);
    expect(getEffectiveStateIcon("idle")).toBe(STATE_ICONS.idle);
  });

  it("returns correct defaults for all states", () => {
    const states: AgentState[] = ["working", "waiting", "directing", "idle", "completed", "exited"];
    for (const state of states) {
      expect(getEffectiveStateIcon(state)).toBe(STATE_ICONS[state]);
    }
  });
});

describe("getEffectiveStateColor", () => {
  it("returns default waiting color", () => {
    expect(getEffectiveStateColor("waiting")).toBe(STATE_COLORS.waiting);
  });

  it("returns default color for non-waiting states", () => {
    expect(getEffectiveStateColor("working")).toBe(STATE_COLORS.working);
  });
});

describe("getEffectiveStateLabel", () => {
  it("returns default label for waiting", () => {
    expect(getEffectiveStateLabel("waiting")).toBe(STATE_LABELS.waiting);
  });

  it("returns default labels for non-waiting states", () => {
    expect(getEffectiveStateLabel("working")).toBe("working");
    expect(getEffectiveStateLabel("completed")).toBe("done");
  });
});
