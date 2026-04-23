import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { PtyManager } from "../PtyManager.js";
import { cleanupPtyManager, sleep } from "./helpers/ptyTestUtils.js";
import { makeAgentResult, makeNoAgentResult } from "../ProcessDetector.js";
import type { TerminalType, PanelKind } from "../../../shared/types/panel.js";

describe("Agent Classification Matrix", () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("Agent terminals should be classified correctly", () => {
    it("should treat terminal with kind='agent' as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as PanelKind,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with agentId as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
        agentId: "claude",
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with type='claude' as agent and set agentId from type", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "claude" as TerminalType,
      });

      await sleep(2000);

      const terminal = manager.getTerminal(id);
      expect(terminal?.agentState).toBeDefined();
      expect(terminal?.agentId).toBe("claude");
    }, 10000);

    it("should treat terminal with type='gemini' as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "gemini" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with type='codex' as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "codex" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with type='opencode' as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "opencode" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with type='claude' but kind='terminal' as agent (type wins)", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as PanelKind,
        type: "claude" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should treat terminal with kind='agent' and agentId as agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as PanelKind,
        agentId: "claude",
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
      expect(terminal?.agentId).toBe("claude");
    }, 10000);

    it("should treat terminal with kind='terminal' but agentId set as agent (agentId wins)", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as PanelKind,
        type: "terminal" as TerminalType,
        agentId: "gemini",
      });

      await sleep(2000);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBeDefined();
      expect(terminal?.agentId).toBe("gemini");
    }, 10000);
  });

  describe("Shell terminals should NOT be classified as agents", () => {
    it("should treat terminal with type='terminal' as shell", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(false);
      expect(terminal?.agentState).toBeUndefined();
    }, 10000);

    it("should treat terminal with kind='terminal' and type='terminal' as shell", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as PanelKind,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(false);
      expect(terminal?.agentState).toBeUndefined();
    }, 10000);

    it("should treat terminal with no kind, type, or agentId as shell", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(false);
      expect(terminal?.agentState).toBeUndefined();
    }, 10000);
  });

  describe("ActivityMonitor initialization", () => {
    it("should start ActivityMonitor for agent terminals", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "claude" as TerminalType,
      });

      await sleep(2000);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.agentState).toBeDefined();
      expect(terminal?.agentState).toBeDefined();
    }, 10000);

    it("should NOT start ActivityMonitor for shell terminals", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.agentState).toBeUndefined();
    }, 10000);
  });

  describe("Runtime agent promotion and demotion", () => {
    it("should start ActivityMonitor when a plain terminal is promoted to an agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      // Sanity: plain shell starts without monitor, state, or analysis flag.
      const before = manager.getTerminal(id);
      expect(before?.analysisEnabled).toBe(false);
      expect(before?.agentState).toBeUndefined();
      expect(before?.detectedAgentType).toBeUndefined();

      const simulated = manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as TerminalType,
          processName: "claude",
        })
      );
      expect(simulated).toBe(true);

      const after = manager.getTerminal(id);
      expect(after?.analysisEnabled).toBe(true);
      expect(after?.agentState).toBeDefined();
      expect(after?.detectedAgentType).toBe("claude");
      expect(after?.type).toBe("claude");
    }, 10000);

    it("should stop ActivityMonitor and clear analysisEnabled when the runtime agent exits", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as TerminalType,
          processName: "claude",
        })
      );

      const promoted = manager.getTerminal(id);
      expect(promoted?.analysisEnabled).toBe(true);
      expect(promoted?.detectedAgentType).toBe("claude");

      manager.simulateAgentDetection(id, makeNoAgentResult({}));

      const demoted = manager.getTerminal(id);
      expect(demoted?.analysisEnabled).toBe(false);
      expect(demoted?.detectedAgentType).toBeUndefined();
      expect(demoted?.type).toBe("terminal");
    }, 10000);

    it("should demote a promoted terminal when a non-agent process replaces the agent", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as TerminalType,
          processName: "claude",
        })
      );
      expect(manager.getTerminal(id)?.analysisEnabled).toBe(true);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          processIconId: "npm",
          processName: "npm",
        })
      );

      const demoted = manager.getTerminal(id);
      expect(demoted?.analysisEnabled).toBe(false);
      expect(demoted?.detectedAgentType).toBeUndefined();
      expect(demoted?.type).toBe("terminal");
    }, 10000);

    it("should preserve analysisEnabled for spawn-time agent terminals when their agent exits", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "claude" as TerminalType,
      });

      await sleep(2000);

      // Spawn-time agent panels keep analysisEnabled=true even after the live
      // agent exits — lifecycle unification here is runtime-only, and these
      // panels remain classified as agent panels for the whole session.
      manager.simulateAgentDetection(id, makeNoAgentResult({}));

      const info = manager.getTerminal(id);
      expect(info?.analysisEnabled).toBe(true);
    }, 10000);

    it("should assign agentId on promotion so AgentStateService accepts state events", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);
      expect(manager.getTerminal(id)?.agentId).toBeUndefined();

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as TerminalType,
          processName: "claude",
        })
      );

      const promoted = manager.getTerminal(id);
      // Without agentId, AgentStateService.updateAgentState() and
      // handleActivityState() hard-return, silently dropping every monitor
      // callback. agentId must be seeded on runtime promotion so the
      // ActivityMonitor's initial busy emit actually flips state to "working".
      expect(promoted?.agentId).toBe("claude");
      expect(promoted?.agentState).toBe("working");

      // Demotion clears agentId back to undefined for runtime-promoted terminals.
      manager.simulateAgentDetection(id, makeNoAgentResult({}));
      expect(manager.getTerminal(id)?.agentId).toBeUndefined();
    }, 10000);

    it("should reconfigure the existing monitor when the detected agent type changes", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        type: "terminal" as TerminalType,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as TerminalType,
          processName: "claude",
        })
      );
      expect(manager.getTerminal(id)?.type).toBe("claude");

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "gemini" as TerminalType,
          processName: "gemini",
        })
      );

      const info = manager.getTerminal(id);
      expect(info?.analysisEnabled).toBe(true);
      expect(info?.type).toBe("gemini");
      expect(info?.detectedAgentType).toBe("gemini");
    }, 10000);
  });
});
