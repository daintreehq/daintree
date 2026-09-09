import { describe, it, expect } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { assessTerminalInterrupt } from "../terminalInterrupt";

function makeAgentPanel(overrides: Record<string, unknown> = {}): PanelInstance {
  return {
    id: "t1",
    title: "t1",
    kind: "terminal",
    detectedAgentId: "claude",
    everDetectedAgent: true,
    worktreeId: "wt-1",
    location: "grid",
    agentState: "working",
    hasPty: true,
    ...overrides,
  } as PanelInstance;
}

describe("assessTerminalInterrupt (#12338)", () => {
  it("accepts a working agent whose CLI advertises Escape", () => {
    const result = assessTerminalInterrupt(makeAgentPanel(), "t1");
    expect(result).toEqual({
      eligible: true,
      terminalId: "t1",
      agentId: "claude",
      agentState: "working",
      support: "advertised",
    });
  });

  it.each(["question", "approval", "error"] as const)(
    "accepts a waiting agent whose turn is still in flight (%s)",
    (waitingReason) => {
      const result = assessTerminalInterrupt(
        makeAgentPanel({ agentState: "waiting", waitingReason }),
        "t1"
      );
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.agentState).toBe("waiting");
    }
  );

  // `"prompt"` is the idle one — documented as an empty input prompt, safe to
  // auto-drive. Letting it through would defeat the idle guard at the exact
  // moment it matters: a second Escape at an idle Claude prompt opens the
  // session rewind menu.
  it("refuses a waiting agent sitting at an empty prompt", () => {
    const result = assessTerminalInterrupt(
      makeAgentPanel({ agentState: "waiting", waitingReason: "prompt" }),
      "t1"
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("waiting rather than running a turn");
  });

  // An absent reason is the common idle shape, not a rare one: the completion
  // timer emits an unclassified idle and the state machine routes it
  // `completed -> waiting`, so a finished agent lands here looking busy.
  it("refuses a waiting agent with no recorded reason", () => {
    const result = assessTerminalInterrupt(
      makeAgentPanel({ agentState: "waiting", waitingReason: undefined }),
      "t1"
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses a panel whose last restart failed", () => {
    const result = assessTerminalInterrupt(
      makeAgentPanel({ agentState: "working", restartError: { kind: "spawn-failed" } }),
      "t1"
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("failed restart");
  });

  // Restart locks the managed terminal without touching the persisted flag and
  // publishes `agentState: "working"` before the replacement process is spawned,
  // so a restarting panel otherwise reads as a busy agent.
  it("refuses a restarting panel even though it reports itself working", () => {
    const result = assessTerminalInterrupt(
      makeAgentPanel({ isRestarting: true, agentState: "working" }),
      "t1"
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("restarting");
  });

  // The distinction the whole feature turns on: an agent nobody has measured
  // still gets the keystrokes, and says so. Refusing on absence of evidence
  // would shrink the tool to whichever CLIs happened to get looked at.
  it("accepts an agent that advertises no interrupt key, marked unverified", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ detectedAgentId: "aider" }), "t1");
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.agentId).toBe("aider");
      expect(result.support).toBe("unverified");
    }
  });

  it("refuses an agent that advertises a different cancel key, naming it", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ detectedAgentId: "goose" }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toContain("goose");
      expect(result.reason).toContain("Ctrl+C");
    }
  });

  it("marks every agent that advertises Escape as advertised", () => {
    for (const agentId of ["claude", "codex", "kiro", "opencode", "mistral"]) {
      const result = assessTerminalInterrupt(makeAgentPanel({ detectedAgentId: agentId }), "t1");
      expect(result.eligible, agentId).toBe(true);
      if (result.eligible) expect(result.support, agentId).toBe("advertised");
    }
  });

  it.each(["idle", "completed", "exited", "directing"] as const)(
    "refuses a target observed %s rather than sending a stray Escape",
    (agentState) => {
      const result = assessTerminalInterrupt(makeAgentPanel({ agentState }), "t1");
      expect(result.eligible).toBe(false);
      if (!result.eligible) expect(result.reason).toContain("not mid-turn");
    }
  );

  it("refuses a target with no observed state at all", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ agentState: undefined }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("no known state");
  });

  it("refuses a plain shell — there is no agent turn to cancel", () => {
    const result = assessTerminalInterrupt(
      makeAgentPanel({ detectedAgentId: undefined, everDetectedAgent: false }),
      "t1"
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("not running a recognised agent");
  });

  it("refuses a trashed panel", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ location: "trash" }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("trash");
  });

  it.each(["exited", "error"] as const)("refuses a panel whose process is %s", (runtimeStatus) => {
    const result = assessTerminalInterrupt(makeAgentPanel({ runtimeStatus }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("already exited");
  });

  // Guards the `=== false` in the source: a `!panel.hasPty` mutation would
  // refuse a valid panel that simply never set the optional field.
  it("accepts a panel that leaves hasPty unset", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ hasPty: undefined }), "t1");
    expect(result.eligible).toBe(true);
  });

  it("refuses a panel with no process attached", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ hasPty: false }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("no process attached");
  });

  // Input lock discards writes at the terminal, so a "sent" here would be a
  // claim about keystrokes that were dropped one layer down.
  it("refuses a panel with input locked", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ isInputLocked: true }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("input locked");
  });

  it("refuses a missing panel", () => {
    const result = assessTerminalInterrupt(undefined, "ghost");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("ghost");
  });

  it("refuses a non-PTY panel kind", () => {
    const result = assessTerminalInterrupt(makeAgentPanel({ kind: "browser" }), "t1");
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("not a terminal with a process");
  });

  // Fleet excludes these because the collapsed dock has nowhere to paint the
  // armed-broadcast warning. An explicitly named panel carries no such problem,
  // and refusing it would tie the tool's reach to where the user parked a pane.
  it.each(["dock", "background"] as const)("accepts an agent parked in %s", (location) => {
    const result = assessTerminalInterrupt(makeAgentPanel({ location }), "t1");
    expect(result.eligible).toBe(true);
  });
});
