import { beforeEach, describe, it, expect } from "vitest";
import { deriveAgentAttentionStates } from "../agentAttentionStates";
import type { PanelInstance } from "@shared/types/panel";
import type { AgentState } from "@shared/types";

/**
 * Own suite because the toolbar's overflow menu and the shared launcher both
 * draw their agent dot from this one derivation — it outlived the component it
 * used to live inside (#11691).
 */

let seq = 0;
let needsYou = new Set<string>();
beforeEach(() => {
  needsYou = new Set();
});

function ptyPanel(over: {
  /** Live detector result — the runtime identity. */
  detectedAgentId?: string;
  /** What the panel was launched as, before any detection commits. */
  launchAgentId?: string;
  agentState?: AgentState;
  worktreeId?: string;
  location?: string;
  /** The fleet places the run in `needs-you`: an unread Canopy ask. */
  asks?: boolean;
}): PanelInstance {
  seq += 1;
  const id = `p-${seq}`;
  if (over.asks) needsYou.add(id);
  return {
    id,
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
  return deriveAgentAttentionStates(
    panelsById,
    panels.map((p) => p.id),
    activeWorktreeId,
    needsYou
  );
}

describe("deriveAgentAttentionStates", () => {
  it("keys a panel under its runtime identity, not the agent it booted as", () => {
    // A plain shell that starts Claude has to be tracked under Claude, or the
    // dot lands on the wrong launcher row.
    const map = derive([
      ptyPanel({
        launchAgentId: "terminal",
        detectedAgentId: "claude",
        agentState: "waiting",
        asks: true,
      }),
    ]);
    expect(map.get("claude")).toBe("waiting");
    expect(map.has("terminal")).toBe(false);
  });

  it("falls back to launch intent before any detector result commits", () => {
    const map = derive([ptyPanel({ launchAgentId: "codex", agentState: "waiting", asks: true })]);
    expect(map.get("codex")).toBe("waiting");
  });

  it.each(["idle", "working"] as const)(
    "counts a %s agent as present even though it earns no dot",
    (agentState) => {
      // The agent is tracked, but its state wants nothing from the user, so the
      // row gets an entry with a null value rather than being left out.
      const map = derive([ptyPanel({ detectedAgentId: "codex", agentState })]);
      expect(map.has("codex")).toBe(true);
      expect(map.get("codex")).toBeNull();
    }
  );

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
        ptyPanel({
          detectedAgentId: "claude",
          agentState: "waiting",
          worktreeId: "wt-1",
          asks: true,
        }),
        ptyPanel({
          detectedAgentId: "gemini",
          agentState: "waiting",
          worktreeId: "wt-2",
          asks: true,
        }),
      ],
      "wt-1"
    );
    expect(map.get("claude")).toBe("waiting");
    expect(map.has("gemini")).toBe(false);
  });

  it("counts every worktree when none is selected", () => {
    const map = derive([
      ptyPanel({
        detectedAgentId: "claude",
        agentState: "waiting",
        worktreeId: "wt-1",
        asks: true,
      }),
      ptyPanel({ detectedAgentId: "gemini", agentState: "directing", worktreeId: "wt-2" }),
    ]);
    expect(map.get("claude")).toBe("waiting");
    expect(map.get("gemini")).toBe("directing");
  });

  it("keeps a waiting session's pip when a sibling of the same agent is working", () => {
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "working" }),
      ptyPanel({ detectedAgentId: "claude", agentState: "waiting", asks: true }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("claude")).toBe("waiting");
  });

  it("skips ids that are missing from the panel map", () => {
    const present = ptyPanel({ detectedAgentId: "claude", agentState: "waiting", asks: true });
    const map = deriveAgentAttentionStates(
      { [present.id]: present },
      [present.id, "ghost"],
      null,
      needsYou
    );
    expect(map.get("claude")).toBe("waiting");
  });

  it("gives a prompt that asks nothing, a hand-back or an error wait no pip", () => {
    // The run is present, but only an unread Canopy ask earns the amber dot.
    const map = derive([ptyPanel({ detectedAgentId: "claude", agentState: "waiting" })]);
    expect(map.has("claude")).toBe(true);
    expect(map.get("claude")).toBeNull();
  });

  it("earns the amber pip for an ask Canopy read on a finished turn", () => {
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "completed", asks: true }),
    ]);
    expect(map.get("claude")).toBe("waiting");
  });

  it("drops the amber pip once the pane has the agent working again", () => {
    const map = derive([
      ptyPanel({ detectedAgentId: "claude", agentState: "working", asks: true }),
    ]);
    expect(map.get("claude")).toBeNull();
  });
});
