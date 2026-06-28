import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { PtyManager } from "../PtyManager.js";
import { cleanupPtyManager, sleep } from "./helpers/ptyTestUtils.js";
import { makeAgentResult, makeNoAgentResult } from "../ProcessDetector.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";

describe("Agent Classification Matrix", () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  afterEach(async () => {
    await cleanupPtyManager(manager);
  });

  describe("Agent terminals should be classified correctly", () => {
    it.each(["claude", "gemini", "codex"] as const)(
      "should enable analysis for terminal launched with launchAgentId=%s",
      async (launchAgentId) => {
        const id = randomUUID();
        manager.spawn(id, {
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          launchAgentId,
        });

        await sleep(100);

        const terminal = manager.getTerminal(id);
        expect(terminal).toBeDefined();
        expect(terminal?.analysisEnabled).toBe(true);
        expect(terminal?.agentState).toBeDefined();
      },
      10000
    );
  });

  describe("Shell terminals should NOT be classified as agents", () => {
    it("should treat plain terminal as shell", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(false);
      expect(terminal?.agentState).toBeUndefined();
    }, 10000);

    it("should treat terminal with no launchAgentId as shell", async () => {
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
    it("should NOT start ActivityMonitor for shell terminals", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
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
      });

      await sleep(100);

      const before = manager.getTerminal(id);
      expect(before?.analysisEnabled).toBe(false);
      expect(before?.agentState).toBeUndefined();
      expect(before?.detectedAgentId).toBeUndefined();

      const simulated = manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as BuiltInAgentId,
          processName: "claude",
        })
      );
      expect(simulated).toBe(true);

      const after = manager.getTerminal(id);
      expect(after?.analysisEnabled).toBe(true);
      expect(after?.agentState).toBeDefined();
      expect(after?.detectedAgentId).toBe("claude");
    }, 10000);

    it("should stop ActivityMonitor and clear analysisEnabled when the runtime agent exits", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as BuiltInAgentId,
          processName: "claude",
        })
      );

      const promoted = manager.getTerminal(id);
      expect(promoted?.analysisEnabled).toBe(true);
      expect(promoted?.detectedAgentId).toBe("claude");

      manager.simulateAgentDetection(id, makeNoAgentResult({}));

      const demoted = manager.getTerminal(id);
      expect(demoted?.analysisEnabled).toBe(false);
      expect(demoted?.detectedAgentId).toBeUndefined();
    }, 10000);

    it("should hold detected agent when a non-agent process icon arrives without explicit exit", async () => {
      // Demote-hold guard (commit 3223f42e4): a `processIconId`-only result
      // without an explicit `no_agent` state must NOT demote a confirmed agent
      // — process-tree blindness/argv rewrites otherwise flip chrome every poll.
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as BuiltInAgentId,
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

      const held = manager.getTerminal(id);
      expect(held?.analysisEnabled).toBe(true);
      expect(held?.detectedAgentId).toBe("claude");
    }, 10000);

    it("should set detectedAgentId on promotion so AgentStateService accepts state events", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      await sleep(100);
      expect(manager.getTerminal(id)?.detectedAgentId).toBeUndefined();

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as BuiltInAgentId,
          processName: "claude",
        })
      );

      const promoted = manager.getTerminal(id);
      expect(promoted?.detectedAgentId).toBe("claude");
      expect(promoted?.agentState).toBe("working");

      manager.simulateAgentDetection(id, makeNoAgentResult({}));
      expect(manager.getTerminal(id)?.detectedAgentId).toBeUndefined();
    }, 10000);

    it("should reconfigure the existing monitor when the detected agent type changes", async () => {
      const id = randomUUID();
      manager.spawn(id, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      await sleep(100);

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "claude" as BuiltInAgentId,
          processName: "claude",
        })
      );
      expect(manager.getTerminal(id)?.detectedAgentId).toBe("claude");

      manager.simulateAgentDetection(
        id,
        makeAgentResult({
          agentType: "gemini" as BuiltInAgentId,
          processName: "gemini",
        })
      );

      const info = manager.getTerminal(id);
      expect(info?.analysisEnabled).toBe(true);
      expect(info?.detectedAgentId).toBe("gemini");
    }, 10000);
  });
});
