/**
 * Tests for AgentAvailabilityStore - Runtime availability tracking for agents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AgentAvailabilityStore,
  MAX_CLOSED_TERMINALS as CLOSED_TERMINAL_CAPACITY,
} from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";

const spawn = (agentId: string, terminalId: string, timestamp = Date.now()) => {
  events.emit("agent:spawned", { agentId, terminalId, timestamp });
};

const transition = (
  agentId: string,
  terminalId: string,
  state: AgentState,
  extra: {
    timestamp?: number;
    waitingReason?: WaitingReason;
    exitCode?: number | null;
    exitSignal?: number;
  } = {}
) => {
  events.emit("agent:state-changed", {
    agentId,
    terminalId,
    state,
    previousState: state === "working" ? "idle" : "working",
    trigger: state === "completed" || state === "exited" ? "exit" : "output",
    confidence: 1,
    ...extra,
    timestamp: extra.timestamp ?? Date.now(),
  });
};

describe("AgentAvailabilityStore", () => {
  let store: AgentAvailabilityStore;

  beforeEach(() => {
    store = new AgentAvailabilityStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.dispose();
  });

  describe("per-terminal state", () => {
    it("records a spawn as working, stamped with the spawn time", () => {
      spawn("claude", "term-1", 1234);

      expect(store.getTerminalSnapshot("term-1")).toEqual({
        terminalId: "term-1",
        agentId: "claude",
        state: "working",
        lastStateChange: 1234,
        spawnedAt: 1234,
      });
      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");
    });

    it("tracks a terminal's state from its own transitions", () => {
      spawn("claude", "term-1", 1_000);
      transition("claude", "term-1", "waiting", { timestamp: 2_000, waitingReason: "prompt" });

      expect(store.getTerminalSnapshot("term-1")).toMatchObject({
        state: "waiting",
        waitingReason: "prompt",
        lastStateChange: 2_000,
        spawnedAt: 1_000,
      });

      transition("claude", "term-1", "working");
      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("waitingReason");
    });

    // #12494 — agent ids name the agent type, so these two share "claude".
    it("keeps same-type terminals in separate slots", () => {
      spawn("claude", "term-a", 1_000);
      spawn("claude", "term-b", 2_000);

      transition("claude", "term-a", "waiting", { timestamp: 3_000, waitingReason: "question" });

      expect(store.getTerminalSnapshot("term-a")).toMatchObject({
        state: "waiting",
        waitingReason: "question",
        lastStateChange: 3_000,
        spawnedAt: 1_000,
      });
      expect(store.getTerminalSnapshot("term-b")).toEqual({
        terminalId: "term-b",
        agentId: "claude",
        state: "working",
        lastStateChange: 2_000,
        spawnedAt: 2_000,
      });
    });

    it("does not reset an existing terminal when a same-type sibling spawns", () => {
      spawn("claude", "term-a");
      transition("claude", "term-a", "waiting", { waitingReason: "prompt" });

      spawn("claude", "term-b");

      expect(store.getTerminalSnapshot("term-a")?.state).toBe("waiting");
      expect(store.getTerminalSnapshot("term-a")?.waitingReason).toBe("prompt");
    });

    it("ignores a transition with no terminalId rather than attributing it by type", () => {
      spawn("claude", "term-1");

      events.emit("agent:state-changed", {
        agentId: "claude",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1,
      });

      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
    });

    it("ignores a transition with no agentId for a terminal it has no record of", () => {
      events.emit("agent:state-changed", {
        terminalId: "term-1",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1,
      });

      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
    });

    // A hand-started agent's identity is cleared as its PTY exits, so the
    // final transition arrives without an agent id.
    it("attributes a transition with no agentId to the terminal's own agent", () => {
      transition("claude", "term-1", "working");

      events.emit("agent:state-changed", {
        terminalId: "term-1",
        state: "exited",
        previousState: "working",
        timestamp: 7_000,
        trigger: "exit",
        confidence: 1,
        exitCode: 0,
      });

      expect(store.getTerminalSnapshot("term-1")).toEqual({
        terminalId: "term-1",
        agentId: "claude",
        state: "exited",
        lastStateChange: 7_000,
        exitCode: 0,
      });
    });

    it("records a transition for a terminal whose spawn it never saw", () => {
      transition("claude", "term-1", "waiting", { timestamp: 5_000 });

      expect(store.getTerminalSnapshot("term-1")).toEqual({
        terminalId: "term-1",
        agentId: "claude",
        state: "waiting",
        lastStateChange: 5_000,
      });
    });
  });

  describe("exit metadata tracking", () => {
    it("caches exitCode from a completed transition", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "completed", { exitCode: 0 });

      expect(store.getTerminalSnapshot("term-1")?.exitCode).toBe(0);
    });

    it("caches a non-zero exitCode from an exited transition", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "exited", { exitCode: 1 });

      expect(store.getTerminalSnapshot("term-1")?.exitCode).toBe(1);
    });

    it("caches a null exitCode plus exitSignal for a signal-terminated exit", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "exited", { exitCode: null, exitSignal: 9 });

      expect(store.getTerminalSnapshot("term-1")?.exitCode).toBeNull();
      expect(store.getTerminalSnapshot("term-1")?.exitSignal).toBe(9);
    });

    it("does not record exit metadata for non-terminal transitions", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "idle", { exitCode: 4, exitSignal: 2 });

      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitCode");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitSignal");
    });

    it("does not carry exit metadata into a later session in the same terminal", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "exited", { exitCode: 1, exitSignal: 9 });

      // The in-PTY respawn path: exited -> idle -> working, then a
      // pattern-detected completion that carries no exit code of its own.
      transition("claude", "term-1", "idle");
      transition("claude", "term-1", "working");
      transition("claude", "term-1", "completed");

      expect(store.getTerminalSnapshot("term-1")?.state).toBe("completed");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitCode");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitSignal");
    });

    it("does not give a different agent started in the same terminal the first one's spawn", () => {
      spawn("claude", "term-1", 1_000);
      transition("claude", "term-1", "exited", { exitCode: 0 });

      transition("codex", "term-1", "working", { timestamp: 2_000 });

      expect(store.getTerminalSnapshot("term-1")).toEqual({
        terminalId: "term-1",
        agentId: "codex",
        state: "working",
        lastStateChange: 2_000,
      });
    });

    it("keeps each same-type terminal's exit metadata its own", () => {
      spawn("claude", "term-a");
      spawn("claude", "term-b");

      transition("claude", "term-a", "completed", { exitCode: 0 });
      transition("claude", "term-b", "exited", { exitCode: null, exitSignal: 15 });

      expect(store.getTerminalSnapshot("term-a")?.exitCode).toBe(0);
      expect(store.getTerminalSnapshot("term-a")).not.toHaveProperty("exitSignal");
      expect(store.getTerminalSnapshot("term-b")?.exitCode).toBeNull();
      expect(store.getTerminalSnapshot("term-b")?.exitSignal).toBe(15);
    });
  });

  describe("respawn state reset (#10816)", () => {
    it("resets a stale 'waiting' state to 'working' on respawn", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "waiting", { waitingReason: "prompt" });
      expect(store.getTerminalSnapshot("term-1")?.state).toBe("waiting");

      // A fresh spawn in the same terminal must not inherit "waiting"; it would
      // otherwise let waitUntilIdle settle as already-idle before the new
      // session's exit event arrives.
      spawn("claude", "term-1");

      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("waitingReason");
      expect(store.getAgentsByAvailability()).toEqual([
        expect.objectContaining({ terminalId: "term-1", available: false }),
      ]);
    });

    it("clears a stale 'exited' state and its exit metadata on respawn", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "exited", { exitCode: 1, exitSignal: 9 });

      spawn("claude", "term-1");

      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitCode");
      expect(store.getTerminalSnapshot("term-1")).not.toHaveProperty("exitSignal");
    });

    it("records the spawn timestamp as the lastStateChange on respawn", () => {
      spawn("claude", "term-1", 1_000);
      transition("claude", "term-1", "waiting", { timestamp: 2_000 });

      spawn("claude", "term-1", 9_999);

      expect(store.getTerminalSnapshot("term-1")?.lastStateChange).toBe(9_999);
      expect(store.getTerminalSnapshot("term-1")?.spawnedAt).toBe(9_999);
    });

    it("takes the new agent type when a terminal respawns as a different agent", () => {
      spawn("claude", "term-1");
      transition("claude", "term-1", "completed", { exitCode: 0 });

      spawn("codex", "term-1");

      expect(store.getAgentIdForTerminal("term-1")).toBe("codex");
      expect(store.getLatestSnapshotForAgent("claude")).toBeUndefined();
      expect(store.getLatestSnapshotForAgent("codex")?.state).toBe("working");
    });

    it("leaves a same-type sibling alone when one terminal respawns", () => {
      spawn("claude", "term-a");
      spawn("claude", "term-b");
      transition("claude", "term-b", "exited", { exitCode: 2 });

      spawn("claude", "term-a");

      expect(store.getTerminalSnapshot("term-b")?.state).toBe("exited");
      expect(store.getTerminalSnapshot("term-b")?.exitCode).toBe(2);
    });
  });

  describe("agent quitting back to its shell", () => {
    const quitToShell = (agentType: string, terminalId: string) => {
      transition(agentType, terminalId, "exited", { exitCode: 0 });
      events.emit("agent:exited", {
        terminalId,
        agentType,
        timestamp: Date.now(),
        exitKind: "subcommand",
      });
    };

    it("drops the record of an agent started by hand, which nothing else would release", () => {
      transition("claude", "term-1", "working");

      quitToShell("claude", "term-1");

      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
      // The shell is still open, so this is untracked, not closed.
      expect(store.isTerminalClosed("term-1")).toBe(false);
    });

    it("keeps a launched terminal's record, whose kill still arrives later", () => {
      spawn("claude", "term-1");

      quitToShell("claude", "term-1");

      expect(store.getTerminalSnapshot("term-1")).toMatchObject({ state: "exited", exitCode: 0 });
    });

    it("keeps the record when the PTY itself exits", () => {
      transition("claude", "term-1", "working");

      events.emit("agent:exited", {
        terminalId: "term-1",
        agentType: "claude",
        timestamp: Date.now(),
        exitKind: "terminal",
      });

      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
    });
  });

  describe("getLatestSnapshotForAgent", () => {
    it("returns undefined for an agent type with no terminal", () => {
      expect(store.getLatestSnapshotForAgent("claude")).toBeUndefined();
    });

    it("returns the whole snapshot of the most recently updated terminal of the type", () => {
      spawn("claude", "term-a");
      spawn("claude", "term-b");
      transition("claude", "term-a", "waiting", { waitingReason: "question" });

      expect(store.getLatestSnapshotForAgent("claude")?.terminalId).toBe("term-a");

      transition("claude", "term-b", "completed", { exitCode: 3 });

      // term-b's own fields, with nothing carried over from term-a.
      expect(store.getLatestSnapshotForAgent("claude")).toMatchObject({
        terminalId: "term-b",
        state: "completed",
        exitCode: 3,
      });
      expect(store.getLatestSnapshotForAgent("claude")).not.toHaveProperty("waitingReason");
    });

    it("falls back to a live sibling when the latest terminal is killed", () => {
      spawn("claude", "term-a");
      spawn("claude", "term-b");
      transition("claude", "term-b", "waiting");

      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-b",
        timestamp: Date.now(),
      });

      expect(store.getLatestSnapshotForAgent("claude")?.terminalId).toBe("term-a");
    });

    it("ignores terminals running a different agent type", () => {
      spawn("claude", "term-a");
      spawn("codex", "term-b");

      expect(store.getLatestSnapshotForAgent("claude")?.terminalId).toBe("term-a");
    });
  });

  describe("getAgentsByAvailability", () => {
    it("returns one row per terminal, even for the same agent type", () => {
      spawn("claude", "term-a", 1_000);
      spawn("claude", "term-b", 2_000);
      transition("claude", "term-b", "waiting", { timestamp: 3_000 });

      const rows = store.getAgentsByAvailability();

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.terminalId === "term-a")).toEqual({
        terminalId: "term-a",
        agentId: "claude",
        available: false,
        state: "working",
        lastStateChange: 1_000,
      });
      expect(rows.find((r) => r.terminalId === "term-b")).toEqual({
        terminalId: "term-b",
        agentId: "claude",
        available: true,
        state: "waiting",
        lastStateChange: 3_000,
      });
    });

    it("counts idle and waiting as available and working as not", () => {
      spawn("claude", "term-1");
      spawn("codex", "term-2");
      spawn("gemini", "term-3");
      transition("claude", "term-1", "idle");
      transition("codex", "term-2", "waiting");

      const available = store
        .getAgentsByAvailability()
        .filter((r) => r.available)
        .map((r) => r.terminalId)
        .sort();
      expect(available).toEqual(["term-1", "term-2"]);
    });

    it("returns empty array when no agents are tracked", () => {
      expect(store.getAgentsByAvailability()).toEqual([]);
    });
  });

  describe("clear", () => {
    it("clears all tracked state", () => {
      spawn("claude", "term-1");
      spawn("codex", "term-2");

      store.clear();

      expect(store.getAgentsByAvailability()).toEqual([]);
      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
    });
  });

  describe("trash filtering", () => {
    it("excludes a trashed terminal from getAgentsByAvailability", () => {
      spawn("claude", "term-1");

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      expect(store.getAgentsByAvailability()).toEqual([]);
    });

    it("re-includes a restored terminal in getAgentsByAvailability", () => {
      spawn("claude", "term-1");

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });
      events.emit("terminal:restored", { id: "term-1" });

      expect(store.getAgentsByAvailability().map((r) => r.terminalId)).toEqual(["term-1"]);
    });

    it("isTrashed and getTrashedAt track a closed terminal until it is restored", () => {
      expect(store.isTrashed("term-1")).toBe(false);
      expect(store.getTrashedAt("term-1")).toBeUndefined();

      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });
      expect(store.isTrashed("term-1")).toBe(true);
      const trashedAt = store.getTrashedAt("term-1");
      expect(trashedAt).toBeDefined();
      // A second read must return the SAME stamp, not a fresh timestamp — a
      // waiter checking in more than once during one trash TTL relies on this.
      expect(store.getTrashedAt("term-1")).toBe(trashedAt);

      events.emit("terminal:restored", { id: "term-1" });
      expect(store.isTrashed("term-1")).toBe(false);
      expect(store.getTrashedAt("term-1")).toBeUndefined();
    });

    it("still counts a same-type sibling when one terminal is trashed", () => {
      spawn("claude", "term-a");
      spawn("claude", "term-b");

      events.emit("terminal:trashed", { id: "term-a", expiresAt: Date.now() + 60000 });

      expect(store.getAgentsByAvailability().map((r) => r.terminalId)).toEqual(["term-b"]);
    });

    it("handles trash before spawn (race condition)", () => {
      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      spawn("claude", "term-1");

      expect(store.getAgentsByAvailability()).toEqual([]);
    });

    it("forgets trash state on clear()", () => {
      spawn("claude", "term-1");
      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });

      store.clear();
      spawn("claude", "term-1");

      expect(store.getAgentsByAvailability().map((r) => r.terminalId)).toEqual(["term-1"]);
    });
  });

  describe("help terminal tracking", () => {
    it("isHelpTerminal returns false for unknown terminal", () => {
      expect(store.isHelpTerminal("unknown-term")).toBe(false);
    });

    it("isHelpTerminal returns true after markAsHelp", () => {
      store.markAsHelp("term-help");
      expect(store.isHelpTerminal("term-help")).toBe(true);
    });

    it("isHelpTerminal returns false after unmarkAsHelp", () => {
      store.markAsHelp("term-help");
      store.unmarkAsHelp("term-help");
      expect(store.isHelpTerminal("term-help")).toBe(false);
    });

    it("excludes a help terminal from getAgentsByAvailability", () => {
      spawn("claude", "term-help");
      store.markAsHelp("term-help");

      expect(store.getAgentsByAvailability()).toEqual([]);
    });

    it("markAsHelp before agent:spawned still excludes the terminal once it spawns", () => {
      store.markAsHelp("term-help");

      spawn("claude", "term-help");

      expect(store.isHelpTerminal("term-help")).toBe(true);
      expect(store.getAgentsByAvailability()).toEqual([]);
    });

    it("still counts a same-type sibling of a help terminal", () => {
      spawn("claude", "term-help");
      spawn("claude", "term-work");
      store.markAsHelp("term-help");

      expect(store.getAgentsByAvailability().map((r) => r.terminalId)).toEqual(["term-work"]);
    });
  });

  // #12339 — a killed terminal used to keep its mapping forever, so
  // waitUntilIdle read the kill's `idle` state and could not tell a closed
  // panel from an agent at rest.
  describe("terminal-scoped release on agent:killed", () => {
    it("drops the terminal mapping when its agent is killed", () => {
      spawn("claude", "term-1");
      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");

      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getAgentIdForTerminal("term-1")).toBeUndefined();
      expect(store.isTerminalClosed("term-1")).toBe(true);
    });

    it("reports an id it has never seen as not closed", () => {
      expect(store.isTerminalClosed("never-existed")).toBe(false);
    });

    // Agent ids name the agent type, so two panels running "claude" share one
    // id and a release has to be keyed by terminal.
    it("killing one terminal leaves a live sibling of the same agent type mapped", () => {
      spawn("claude", "term-old");
      spawn("claude", "term-new");

      // Model the real kill of term-old, which emits its idle transition first
      // and only then the kill notice.
      events.emit("agent:state-changed", {
        agentId: "claude",
        terminalId: "term-old",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "exit",
        confidence: 1,
      });
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-old",
        timestamp: Date.now(),
      });

      // Only the killed terminal is released; the live sibling keeps its record.
      expect(store.getAgentIdForTerminal("term-old")).toBeUndefined();
      expect(store.getAgentIdForTerminal("term-new")).toBe("claude");
      expect(store.isTerminalClosed("term-old")).toBe(true);
      expect(store.isTerminalClosed("term-new")).toBe(false);
      // term-old's idle was its own; the sibling is still where its spawn put it.
      expect(store.getTerminalSnapshot("term-new")?.state).toBe("working");
    });

    it("drops the killed terminal's state along with its mapping", () => {
      spawn("claude", "term-1");
      events.emit("agent:state-changed", {
        agentId: "claude",
        terminalId: "term-1",
        state: "waiting",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1,
      });

      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
      expect(store.getLatestSnapshotForAgent("claude")).toBeUndefined();
    });

    // A title report queued before the kill can still land after it.
    it("does not revive a killed terminal from a transition that trails the kill", () => {
      spawn("claude", "term-1");
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      transition("claude", "term-1", "working");

      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
      expect(store.isTerminalClosed("term-1")).toBe(true);
    });

    // A restarted pane comes back as a plain shell, so an agent the user then
    // starts by hand is detected rather than announcing a spawn.
    it("reopens a closed terminal when detection promotes a hand-started agent in it", () => {
      spawn("claude", "term-1");
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      events.emit("agent:detected", {
        terminalId: "term-1",
        agentType: "claude",
        processName: "claude",
        timestamp: Date.now(),
      });
      transition("claude", "term-1", "working");

      expect(store.isTerminalClosed("term-1")).toBe(false);
      expect(store.getTerminalSnapshot("term-1")?.state).toBe("working");
    });

    it("does not reopen a closed terminal for a plain process detection", () => {
      spawn("claude", "term-1");
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      events.emit("agent:detected", {
        terminalId: "term-1",
        processIconId: "npm",
        processName: "npm",
        timestamp: Date.now(),
      });
      transition("claude", "term-1", "working");

      expect(store.isTerminalClosed("term-1")).toBe(true);
      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
    });

    it("a respawn after trash and kill is counted again", () => {
      spawn("claude", "term-1");
      events.emit("terminal:trashed", { id: "term-1", expiresAt: Date.now() + 60000 });
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      spawn("claude", "term-1");

      expect(store.getAgentsByAvailability().map((r) => r.terminalId)).toEqual(["term-1"]);
    });

    it("ignores an agent:killed with no terminalId", () => {
      spawn("claude", "term-1");

      events.emit("agent:killed", { agentId: "claude", timestamp: Date.now() });

      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");
    });

    it("a respawn under the same terminal id clears the closed mark", () => {
      spawn("claude", "term-1");
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      expect(store.isTerminalClosed("term-1")).toBe(true);

      spawn("claude", "term-1");

      expect(store.isTerminalClosed("term-1")).toBe(false);
      expect(store.getAgentIdForTerminal("term-1")).toBe("claude");
    });

    it("marks a terminal closed even when no mapping was ever recorded", () => {
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "unmapped",
        timestamp: Date.now(),
      });

      expect(store.isTerminalClosed("unmapped")).toBe(true);
    });

    const close = (terminalId: string) =>
      events.emit("agent:killed", { agentId: "claude", terminalId, timestamp: Date.now() });

    it("remembers a full capacity of closed terminals", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      // Every one still answers "closed" — asserting the boundary rather than
      // just "the newest survived", which would hold for a capacity of one.
      const forgotten = Array.from(
        { length: CLOSED_TERMINAL_CAPACITY },
        (_, i) => `term-${i}`
      ).filter((id) => !store.isTerminalClosed(id));
      expect(forgotten).toEqual([]);
    });

    it("evicts exactly the oldest entry when one more closes", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      close("term-overflow");

      // Assert the WHOLE retained set, not a few samples: an implementation
      // that evicted two on overflow would pass a spot check of term-0/term-1.
      const stillClosed = [
        ...Array.from({ length: CLOSED_TERMINAL_CAPACITY }, (_, i) => `term-${i}`),
        "term-overflow",
      ].filter((id) => store.isTerminalClosed(id));
      expect(stillClosed).toEqual([
        ...Array.from({ length: CLOSED_TERMINAL_CAPACITY - 1 }, (_, i) => `term-${i + 1}`),
        "term-overflow",
      ]);
      // Eviction downgrades to "not closed" (which the handler reports as
      // `unknown`) — never back to tracked, since no mapping is recreated.
      expect(store.getAgentIdForTerminal("term-0")).toBeUndefined();
    });

    it("re-closing an entry refreshes its recency so the next-oldest ages out", () => {
      for (let i = 0; i < CLOSED_TERMINAL_CAPACITY; i += 1) close(`term-${i}`);

      close("term-0");
      close("term-overflow");

      // term-0 was refreshed, so term-1 is now the oldest and goes instead.
      expect(store.isTerminalClosed("term-0")).toBe(true);
      expect(store.isTerminalClosed("term-1")).toBe(false);
    });

    it("clear() forgets closed terminals", () => {
      events.emit("agent:killed", {
        agentId: "claude",
        terminalId: "term-1",
        timestamp: Date.now(),
      });
      store.clear();

      expect(store.isTerminalClosed("term-1")).toBe(false);
    });
  });

  describe("dispose", () => {
    it("stops listening to events after dispose", () => {
      spawn("claude", "term-1");
      store.dispose();

      transition("claude", "term-1", "waiting");

      expect(store.getTerminalSnapshot("term-1")).toBeUndefined();
    });
  });
});
