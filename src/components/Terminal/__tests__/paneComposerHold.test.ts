import { beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";
import { paneComposerHold } from "../paneComposerHold";

function setPanel(overrides: Partial<PtyPanelData>): void {
  const panel = {
    id: "t1",
    title: "t1",
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    projectId: "proj-1",
    location: "grid",
    agentState: "working",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
  usePanelStore.setState({ panelsById: { t1: panel }, panelIds: ["t1"] });
}

describe("paneComposerHold.mayHold (#16872)", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("asks main to hold a send at a choice dialog", () => {
    setPanel({ agentState: "waiting", waitingReason: "approval" });
    expect(paneComposerHold("t1").mayHold()).toBe(true);
  });

  it("asks main about a working agent, whose turn may have opened a dialog since", () => {
    for (const agentId of ["claude", "codex", "antigravity", "gemini"]) {
      setPanel({ detectedAgentId: agentId, agentState: "working" });
      expect(paneComposerHold("t1").mayHold()).toBe(true);
    }
    setPanel({ detectedAgentId: undefined, agentState: "working" });
    expect(paneComposerHold("t1").mayHold()).toBe(false);
  });

  it("sends at once at a prose question, a prompt, idle, in a shell, and with no panel", () => {
    setPanel({ agentState: "waiting", waitingReason: "question" });
    expect(paneComposerHold("t1").mayHold()).toBe(false);
    setPanel({ agentState: "waiting", waitingReason: "prompt" });
    expect(paneComposerHold("t1").mayHold()).toBe(false);
    setPanel({ agentState: "idle" });
    expect(paneComposerHold("t1").mayHold()).toBe(false);
    setPanel({ detectedAgentId: undefined, agentState: "waiting", waitingReason: "approval" });
    expect(paneComposerHold("t1").mayHold()).toBe(false);
    expect(paneComposerHold("missing").mayHold()).toBe(false);
  });
});
