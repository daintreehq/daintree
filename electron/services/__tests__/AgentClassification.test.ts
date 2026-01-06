import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import type { PtyManager } from "../PtyManager.js";
import type { TerminalType, TerminalKind } from "../../../shared/types/domain.js";

let PtyManagerClass: any;
let testUtils: any;

try {
  PtyManagerClass = (await import("../PtyManager.js")).PtyManager;
  testUtils = await import("./helpers/ptyTestUtils.js");
} catch (_error) {
  console.warn("node-pty not available, skipping agent classification tests");
}

const shouldSkip = !PtyManagerClass;

describe.skipIf(shouldSkip)("Agent Classification Matrix", () => {
  const { cleanupPtyManager, sleep } = testUtils || {};
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManagerClass();
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
        kind: "agent" as TerminalKind,
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

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBe("idle");
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
        kind: "terminal" as TerminalKind,
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
        kind: "agent" as TerminalKind,
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
        kind: "terminal" as TerminalKind,
        type: "terminal" as TerminalType,
        agentId: "gemini",
      });

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.analysisEnabled).toBe(true);
      expect(terminal?.agentState).toBe("idle");
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
        kind: "terminal" as TerminalKind,
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

      await sleep(100);

      const terminal = manager.getTerminal(id);
      expect(terminal).toBeDefined();
      expect(terminal?.agentState).toBeDefined();
      expect(terminal?.agentState).toBe("idle");
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
});
