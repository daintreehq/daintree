import { describe, it, expect } from "vitest";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
  STATE_ICONS,
  STATE_COLORS,
  STATE_LABELS,
} from "../terminalStateConfig";
import { PromptCircle, QuestionCircle } from "@/components/icons/AgentStateCircles";
import type { AgentState } from "@/types";

describe("getEffectiveStateIcon", () => {
  it("returns PromptCircle for waiting + prompt", () => {
    expect(getEffectiveStateIcon("waiting", "prompt")).toBe(PromptCircle);
  });

  it("returns QuestionCircle for waiting + question", () => {
    expect(getEffectiveStateIcon("waiting", "question")).toBe(QuestionCircle);
  });

  it("returns default icon for waiting without reason", () => {
    expect(getEffectiveStateIcon("waiting")).toBe(STATE_ICONS.waiting);
  });

  it("returns default icon for non-waiting states even with waitingReason", () => {
    expect(getEffectiveStateIcon("working", "prompt")).toBe(STATE_ICONS.working);
    expect(getEffectiveStateIcon("idle", "question")).toBe(STATE_ICONS.idle);
  });

  it("returns correct defaults for all states", () => {
    const states: AgentState[] = ["working", "running", "waiting", "directing", "idle", "completed"];
    for (const state of states) {
      expect(getEffectiveStateIcon(state)).toBe(STATE_ICONS[state]);
    }
  });
});

describe("getEffectiveStateColor", () => {
  it("returns warning color for waiting + prompt", () => {
    expect(getEffectiveStateColor("waiting", "prompt")).toBe("text-status-warning");
  });

  it("returns default waiting color for waiting + question", () => {
    expect(getEffectiveStateColor("waiting", "question")).toBe(STATE_COLORS.waiting);
  });

  it("returns default color for non-waiting states", () => {
    expect(getEffectiveStateColor("working", "prompt")).toBe(STATE_COLORS.working);
  });
});

describe("getEffectiveStateLabel", () => {
  it("returns 'waiting for input' for waiting + prompt", () => {
    expect(getEffectiveStateLabel("waiting", "prompt")).toBe("waiting for input");
  });

  it("returns 'waiting (question)' for waiting + question", () => {
    expect(getEffectiveStateLabel("waiting", "question")).toBe("waiting (question)");
  });

  it("returns default label for waiting without reason", () => {
    expect(getEffectiveStateLabel("waiting")).toBe(STATE_LABELS.waiting);
  });

  it("returns default labels for non-waiting states", () => {
    expect(getEffectiveStateLabel("working")).toBe("working");
    expect(getEffectiveStateLabel("completed")).toBe("done");
  });
});
