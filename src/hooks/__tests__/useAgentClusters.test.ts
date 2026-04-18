import { describe, it, expect } from "vitest";
import { deriveHighestPriorityCluster } from "../useAgentClusters";
import type { TerminalInstance } from "@shared/types";

const NOW = 1_700_000_000_000;

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...overrides,
  } as TerminalInstance;
}

function build(terminals: TerminalInstance[]) {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  return { panelsById, panelIds };
}

const noTrash = () => false;

function derive(terminals: TerminalInstance[], now: number = NOW) {
  const { panelsById, panelIds } = build(terminals);
  return deriveHighestPriorityCluster({ panelIds, panelsById, isInTrash: noTrash, now });
}

describe("deriveHighestPriorityCluster", () => {
  describe("empty / single-member", () => {
    it("returns null when no panels", () => {
      expect(derive([])).toBeNull();
    });

    it("returns null when only one waiting-prompt agent", () => {
      expect(
        derive([
          makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        ])
      ).toBeNull();
    });
  });

  describe("prompt cluster", () => {
    it("detects a 2-member prompt cluster", () => {
      const cluster = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW - 5,
        }),
        makeAgent("b", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW - 1,
        }),
      ]);
      expect(cluster).not.toBeNull();
      expect(cluster!.type).toBe("prompt");
      expect(cluster!.count).toBe(2);
      expect(cluster!.memberIds).toEqual(["a", "b"]);
      expect(cluster!.latestStateChange).toBe(NOW - 1);
      expect(cluster!.headline).toBe("2 agents need input");
    });

    it("excludes waiting agents with waitingReason='question'", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "question", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("excludes waiting agents with no waitingReason", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });
  });

  describe("error cluster", () => {
    it("detects ≥2 exited agents with non-zero exit codes", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "exited", exitCode: 1, lastStateChange: NOW - 100 }),
        makeAgent("b", { agentState: "exited", exitCode: 137, lastStateChange: NOW - 10 }),
      ]);
      expect(cluster).not.toBeNull();
      expect(cluster!.type).toBe("error");
      expect(cluster!.count).toBe(2);
      expect(cluster!.headline).toBe("2 agents exited with errors");
    });

    it("excludes exited agents with exitCode 0", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "exited", exitCode: 1, lastStateChange: NOW }),
        makeAgent("b", { agentState: "exited", exitCode: 0, lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("excludes exited agents with undefined exitCode", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "exited", exitCode: 1, lastStateChange: NOW }),
        makeAgent("b", { agentState: "exited", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });
  });

  describe("completion cluster", () => {
    it("detects completions within the 30s window", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "completed", lastStateChange: NOW - 1_000 }),
        makeAgent("b", { agentState: "completed", lastStateChange: NOW - 15_000 }),
      ]);
      expect(cluster).not.toBeNull();
      expect(cluster!.type).toBe("completion");
      expect(cluster!.count).toBe(2);
    });

    it("excludes completions older than 30s", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "completed", lastStateChange: NOW - 1_000 }),
        makeAgent("b", { agentState: "completed", lastStateChange: NOW - 31_000 }),
      ]);
      expect(cluster).toBeNull();
    });

    it("includes completions at the exact 30s boundary (inclusive)", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "completed", lastStateChange: NOW - 30_000 }),
        makeAgent("b", { agentState: "completed", lastStateChange: NOW - 30_000 }),
      ]);
      expect(cluster).not.toBeNull();
      expect(cluster!.type).toBe("completion");
    });

    it("excludes completions with no lastStateChange", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "completed", lastStateChange: NOW }),
        makeAgent("b", { agentState: "completed" }),
      ]);
      expect(cluster).toBeNull();
    });
  });

  describe("priority order", () => {
    it("prompt beats error and completion when all three are active", () => {
      const cluster = derive([
        makeAgent("p1", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("p2", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("e1", { agentState: "exited", exitCode: 1, lastStateChange: NOW }),
        makeAgent("e2", { agentState: "exited", exitCode: 2, lastStateChange: NOW }),
        makeAgent("c1", { agentState: "completed", lastStateChange: NOW }),
        makeAgent("c2", { agentState: "completed", lastStateChange: NOW }),
      ]);
      expect(cluster?.type).toBe("prompt");
    });

    it("error beats completion when prompt is absent", () => {
      const cluster = derive([
        makeAgent("e1", { agentState: "exited", exitCode: 1, lastStateChange: NOW }),
        makeAgent("e2", { agentState: "exited", exitCode: 2, lastStateChange: NOW }),
        makeAgent("c1", { agentState: "completed", lastStateChange: NOW }),
        makeAgent("c2", { agentState: "completed", lastStateChange: NOW }),
      ]);
      expect(cluster?.type).toBe("error");
    });
  });

  describe("eligibility guards", () => {
    it("excludes trashed terminals", () => {
      const cluster = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW,
          location: "trash",
        }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("excludes background terminals", () => {
      const cluster = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW,
          location: "background",
        }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("excludes non-agent terminals", () => {
      const cluster = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW,
          kind: "terminal",
          agentId: undefined,
        }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("excludes terminals with hasPty=false", () => {
      const cluster = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW,
          hasPty: false,
        }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      expect(cluster).toBeNull();
    });

    it("respects the isInTrash predicate", () => {
      const { panelsById, panelIds } = build([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      const cluster = deriveHighestPriorityCluster({
        panelIds,
        panelsById,
        isInTrash: (id) => id === "a",
        now: NOW,
      });
      expect(cluster).toBeNull();
    });

    it("tolerates missing entries in panelsById", () => {
      const cluster = deriveHighestPriorityCluster({
        panelIds: ["missing", "a", "b"],
        panelsById: {
          a: makeAgent("a", {
            agentState: "waiting",
            waitingReason: "prompt",
            lastStateChange: NOW,
          }),
          b: makeAgent("b", {
            agentState: "waiting",
            waitingReason: "prompt",
            lastStateChange: NOW,
          }),
        },
        isInTrash: noTrash,
        now: NOW,
      });
      expect(cluster?.count).toBe(2);
    });
  });

  describe("signature stability", () => {
    it("memberIds follow panelIds order, not insertion order of panelsById", () => {
      const panelIds = ["b", "a"];
      const panelsById = {
        a: makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        b: makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      };
      const cluster = deriveHighestPriorityCluster({
        panelIds,
        panelsById,
        isInTrash: noTrash,
        now: NOW,
      });
      expect(cluster?.memberIds).toEqual(["b", "a"]);
    });

    it("signature is stable across identical inputs", () => {
      const terminals = [
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ];
      const s1 = derive(terminals)!.signature;
      const s2 = derive(terminals)!.signature;
      expect(s1).toBe(s2);
    });

    it("signature changes when latestStateChange advances", () => {
      const s1 = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW - 100,
        }),
        makeAgent("b", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW - 100,
        }),
      ])!.signature;
      const s2 = derive([
        makeAgent("a", {
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: NOW - 100,
        }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ])!.signature;
      expect(s1).not.toBe(s2);
    });

    it("signature changes when membership changes", () => {
      const s1 = derive([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ])!.signature;
      const s2 = derive([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("c", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ])!.signature;
      expect(s1).not.toBe(s2);
    });

    it("signature is sorted so order of panels does not affect it", () => {
      const termsAsc = [
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ];
      const termsDesc = [
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ];
      expect(derive(termsAsc)!.signature).toBe(derive(termsDesc)!.signature);
    });
  });

  describe("headline variants", () => {
    it("uses plural correctly for ≥2 agents", () => {
      const cluster = derive([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
        makeAgent("c", { agentState: "waiting", waitingReason: "prompt", lastStateChange: NOW }),
      ]);
      expect(cluster?.headline).toBe("3 agents need input");
    });
  });
});
