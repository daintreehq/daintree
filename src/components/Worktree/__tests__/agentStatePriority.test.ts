import { describe, it, expect } from "vitest";
import {
  agentStateDotColor,
  ATTENTION_PRIORITY,
  getAttentionAgentState,
  getDominantAgentState,
  STATE_COLORS,
  STATE_PRIORITY,
} from "../terminalStateConfig";
import type { AgentState } from "@/types";

describe("getDominantAgentState", () => {
  it("returns null when all states are undefined", () => {
    expect(getDominantAgentState([undefined, undefined])).toBeNull();
  });

  it("returns null when dominant state is idle", () => {
    expect(getDominantAgentState(["idle", "idle"])).toBeNull();
  });

  it("prefers working over lower-priority states", () => {
    expect(getDominantAgentState(["idle", "completed", "working"])).toBe("working");
  });

  it("prefers directing over completed", () => {
    expect(getDominantAgentState(["completed", "directing"])).toBe("directing");
  });

  // WorktreeCard's border-flash animation depends on working outranking
  // waiting. The pips do not ride on this ranking (see getAttentionAgentState),
  // so this guard only protects the card.
  it("returns working when a worktree mixes working and waiting", () => {
    expect(getDominantAgentState(["working", "waiting"])).toBe("working");
  });

  // Pins the #6661 fix: waiting (actionable) must outrank completed (passive)
  // so every surface reading the dominant state agrees on a single winner. Both input orders are asserted because the
  // implementation is order-independent and a future inline-iteration rewrite
  // could quietly reintroduce order sensitivity.
  it("returns waiting when a worktree mixes completed and waiting (waiting outranks completed)", () => {
    expect(getDominantAgentState(["completed", "waiting"])).toBe("waiting");
    expect(getDominantAgentState(["waiting", "completed"])).toBe("waiting");
  });
});

// STATE_PRIORITY is consumed directly by WorktreeHeader, WorktreeTerminalSection,
// and (via getDominantAgentState) the worktree card — a silent reorder
// or omission here would drift behavior across all of them at once. These
// invariants pin the array shape so the function-level tests above can't be
// the only thing standing between the source of truth and the UI.
describe("STATE_PRIORITY contract", () => {
  it("includes every AgentState exactly once", () => {
    // The `satisfies Record<AgentState, 1>` clause turns this into a
    // compile-time exhaustiveness check — if a new AgentState value is added
    // to the union, this object literal fails typecheck unless the new key
    // is also added here, which keeps the runtime comparison honest.
    const allStates = {
      working: 1,
      directing: 1,
      waiting: 1,
      completed: 1,
      exited: 1,
      idle: 1,
    } satisfies Record<AgentState, 1>;
    const all = Object.keys(allStates) as AgentState[];
    expect([...STATE_PRIORITY].sort()).toEqual([...all].sort());
    expect(STATE_PRIORITY.length).toBe(new Set(STATE_PRIORITY).size);
  });

  it.each([
    ["working", "directing"],
    ["directing", "waiting"],
    ["waiting", "completed"],
    ["completed", "exited"],
    ["exited", "idle"],
  ] as const)("ranks %s above %s", (higher, lower) => {
    expect(STATE_PRIORITY.indexOf(higher)).toBeLessThan(STATE_PRIORITY.indexOf(lower));
  });
});

const ALL_STATES: AgentState[] = ["working", "directing", "waiting", "completed", "exited", "idle"];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

describe("getAttentionAgentState", () => {
  it("returns null when no session wants the user", () => {
    expect(getAttentionAgentState([])).toBeNull();
    expect(
      getAttentionAgentState(["working", "completed", "exited", "idle", undefined])
    ).toBeNull();
  });

  // The regression this exists for: a pip ranked by STATE_PRIORITY let one
  // busy session hide a sibling that was waiting on the user.
  it("never lets another session hide a waiting one, in any order", () => {
    for (const order of permutations(ALL_STATES)) {
      expect(getAttentionAgentState(order)).toBe("waiting");
    }
  });

  it("returns directing when nothing is waiting, whatever else is running", () => {
    const others = ALL_STATES.filter((s) => s !== "waiting");
    for (const order of permutations(others)) {
      expect(getAttentionAgentState(order)).toBe("directing");
    }
  });

  it("only ever answers with a state the sessions are actually in", () => {
    for (const state of ALL_STATES) {
      const result = getAttentionAgentState([state]);
      expect(result === null || result === state).toBe(true);
    }
  });
});

describe("agentStateDotColor", () => {
  it("colours exactly the attention states", () => {
    for (const state of ALL_STATES) {
      const isAttention = (ATTENTION_PRIORITY as readonly AgentState[]).includes(state);
      expect(agentStateDotColor(state) !== null).toBe(isAttention);
    }
  });

  // A pip and the state's own glyph must share a hue, or the same state reads
  // as two different things on the toolbar and in the pane.
  it.each(ATTENTION_PRIORITY)("paints %s in the hue of its canonical state glyph", (state) => {
    const pip = agentStateDotColor(state);
    expect(pip).toMatch(/^bg-/);
    expect(pip!.replace(/^bg-/, "text-")).toBe(STATE_COLORS[state]);
  });

  it("gives every attention state a distinct pip", () => {
    const colors = ATTENTION_PRIORITY.map((s) => agentStateDotColor(s));
    expect(new Set(colors).size).toBe(colors.length);
  });
});
