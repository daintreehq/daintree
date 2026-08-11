import { describe, it, expect } from "vitest";
import { deriveAgentDominantStates } from "../agentDominantStates";
import type { PanelInstance } from "@shared/types/panel";
import type { AgentState } from "@shared/types";

/**
 * Own suite because the toolbar's overflow menu and the shared launcher both
 * draw their agent dot from this one derivation — it outlived the component it
 * used to live inside (#11691).
 */

let seq = 0;
function ptyPanel(over: {
  /** Live detector result — the runtime identity. */
  detectedAgentId?: string;
  /** What the panel was launched as, before any detection commits. */
  launchAgentId?: string;
  agentState?: AgentState;
  worktreeId?: string;
  location?: string;
}): PanelInstance {
  seq += 1;
  return {
    id: `p-${seq}`,
    kind: "terminal",
    title: "t",
    location: over.location ?? "grid",
    detectedAgentId: over.detectedAgentId,
    launchAgentId: over.launchAgentId,
    agentState: over.agentState,
    worktreeId: over.worktreeId,
  } as unknown as PanelInstance;
}

function derive(panels: PanelInstance[], activeWorktreeId: string | null = null) {
  const panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
  return deriveAgentDominantStates(
    panelsById,
    panels.map((p) => p.id),
    activeWorktreeId
  );
}

describe("deriveAgentDominantStates", () => {
  it("keys a panel under its runtime identity, not the agent it booted as", () => {
    // A plain shell that starts Claude has to be tracked under Claude, or the
    // dot lands on the wrong launcher row.
    const map = derive([
      ptyPanel({ launchAgentId: "terminal", detectedAgentId: "claude", agentState: "working" }),
    ]);
    expect(map.get("claude")).toBe("working");
    expect(map.has("terminal")).toBe(false);
  });

  it("falls back to launch intent before any detector result commits", () => {
    const map = derive([ptyPanel({ launchAgentId: "codex", agentState: "working" })]);
    expect(map.get("codex")).toBe("working");
  });

  it("counts an idle agent as present even though it earns no dot", () => {
    // `idle` is an active state — the agent is tracked — but the shared ranking
    // resolves it to no colour, so the row must get an entry with a null value
    // rather than being left out entirely.
    const map = derive([ptyPanel({ detectedAgentId: "codex", agentState: "idle" })]);
    expect(map.has("codex")).toBe(true);
    expect(map.get("codex")).toBeNull();
  });

  it.each(["trash", "background", "overlay"])("ignores panels parked in %s", (location) => {
    const map = derive([ptyPanel({ detectedAgentId: "claude", agentState: "working", location })]);
    expect(map.size).toBe(0);
  });

  it("ignores states outside the active set", () => {
    // `exited`/`completed` are not running, so they contribute no dot.
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "exited" as AgentState }),
      ptyPanel({ detectedAgentId: "claude", agentState: "completed" as AgentState }),
    ]);
    expect(map.has("claude")).toBe(false);
  });

  it("counts only the active worktree once one is selected", () => {
    const map = derive(
      [
        ptyPanel({ detectedAgentId: "claude", agentState: "working", worktreeId: "wt-1" }),
        ptyPanel({ detectedAgentId: "gemini", agentState: "working", worktreeId: "wt-2" }),
      ],
      "wt-1"
    );
    expect(map.get("claude")).toBe("working");
    expect(map.has("gemini")).toBe(false);
  });

  it("counts every worktree when none is selected", () => {
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "working", worktreeId: "wt-1" }),
      ptyPanel({ detectedAgentId: "gemini", agentState: "working", worktreeId: "wt-2" }),
    ]);
    expect(map.get("claude")).toBe("working");
    expect(map.get("gemini")).toBe("working");
  });

  it("collapses several panels of one agent into a single dominant state", () => {
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "idle" }),
      ptyPanel({ detectedAgentId: "claude", agentState: "waiting" }),
    ]);
    expect(map.size).toBe(1);
    // Whichever the shared ranking picks, it must be one of the two observed —
    // never a state no panel is actually in.
    expect(["idle", "waiting"]).toContain(map.get("claude"));
  });

  it("skips ids that are missing from the panel map", () => {
    const present = ptyPanel({ detectedAgentId: "claude", agentState: "working" });
    const map = deriveAgentDominantStates({ [present.id]: present }, [present.id, "ghost"], null);
    expect(map.get("claude")).toBe("working");
  });

  it("returns primitive values so a shallow selector can bail on unchanged ticks", () => {
    // The whole reason this runs inside `useShallow` (#7451) — a Map of objects
    // would re-render every subscriber on every panel-store spread.
    const map = derive([ptyPanel({ detectedAgentId: "claude", agentState: "working" })]);
    for (const value of map.values()) {
      expect(value === null || typeof value === "string").toBe(true);
    }
  });
});
