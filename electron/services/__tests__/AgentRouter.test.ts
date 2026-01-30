/**
 * Tests for AgentRouter - Capability-based router for intelligent agent dispatch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentRouter } from "../AgentRouter.js";
import { AgentAvailabilityStore } from "../AgentAvailabilityStore.js";

describe("AgentRouter", () => {
  let router: AgentRouter;
  let availabilityStore: AgentAvailabilityStore;

  beforeEach(() => {
    availabilityStore = new AgentAvailabilityStore();
    router = new AgentRouter(availabilityStore);

    // Register agents with their initial states
    availabilityStore.registerAgent("claude", "idle");
    availabilityStore.registerAgent("gemini", "idle");
    availabilityStore.registerAgent("codex", "idle");

    vi.clearAllMocks();
  });

  afterEach(() => {
    availabilityStore.dispose();
  });

  describe("routeTask", () => {
    it("returns an agent when no hints provided", async () => {
      const agentId = await router.routeTask();

      // Should return one of the available agents
      expect(["claude", "gemini", "codex", "opencode"]).toContain(agentId);
    });

    it("returns null when no agents match required capabilities", async () => {
      const agentId = await router.routeTask({
        requiredCapabilities: ["nonexistent-capability-xyz"],
      });

      expect(agentId).toBeNull();
    });

    it("filters by required capabilities", async () => {
      // Claude, Gemini, and Codex all have javascript
      const agentId = await router.routeTask({
        requiredCapabilities: ["javascript"],
      });

      expect(["claude", "gemini", "codex", "opencode"]).toContain(agentId);
    });

    it("returns null when agent is at max concurrent tasks", async () => {
      // Simulate claude having max concurrent tasks (2 for claude based on registry)
      availabilityStore.registerAgent("claude", "idle");

      // Simulate 2 tasks assigned
      const { events } = await import("../events.js");
      events.emit("task:assigned", { taskId: "t1", agentId: "claude", timestamp: Date.now() });
      events.emit("task:assigned", { taskId: "t2", agentId: "claude", timestamp: Date.now() });

      // Also set gemini and codex to max
      events.emit("task:assigned", { taskId: "t3", agentId: "gemini", timestamp: Date.now() });
      events.emit("task:assigned", { taskId: "t4", agentId: "gemini", timestamp: Date.now() });
      events.emit("task:assigned", { taskId: "t5", agentId: "codex", timestamp: Date.now() });
      events.emit("task:assigned", { taskId: "t6", agentId: "codex", timestamp: Date.now() });
      events.emit("task:assigned", { taskId: "t7", agentId: "opencode", timestamp: Date.now() });

      // Now all agents should be at capacity
      const agentId = await router.routeTask({
        requiredCapabilities: ["javascript"],
      });

      expect(agentId).toBeNull();
    });
  });

  describe("scoreCandidates", () => {
    it("scores candidates with reasons", async () => {
      const scores = await router.scoreCandidates({
        preferredDomains: ["frontend"],
      });

      expect(scores.length).toBeGreaterThan(0);

      for (const score of scores) {
        expect(score.agentId).toBeDefined();
        expect(score.score).toBeGreaterThan(0);
        expect(score.reasons.length).toBeGreaterThan(0);
      }
    });

    it("returns empty array when no agents match", async () => {
      const scores = await router.scoreCandidates({
        requiredCapabilities: ["nonexistent-capability-xyz"],
      });

      expect(scores).toEqual([]);
    });

    it("scores by domain weight", async () => {
      const scores = await router.scoreCandidates({
        preferredDomains: ["refactoring"],
      });

      // Claude has refactoring: 0.95, which is the highest
      const claudeScore = scores.find((s) => s.agentId === "claude");
      expect(claudeScore).toBeDefined();

      // Claude should have a high score for refactoring
      expect(claudeScore!.reasons.some((r) => r.includes("domain"))).toBe(true);
    });

    it("gives availability bonus to available agents", async () => {
      // Emit state changes to ensure agents are tracked as available
      const { events } = await import("../events.js");
      events.emit("agent:state-changed", {
        agentId: "claude",
        state: "idle",
        previousState: "working",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      const scores = await router.scoreCandidates();

      // Claude should have the availability bonus since we emitted a state change
      const claudeScore = scores.find((s) => s.agentId === "claude");
      expect(claudeScore).toBeDefined();
      expect(claudeScore!.reasons.some((r) => r.includes("available"))).toBe(true);
    });

    it("considers load factor in scoring", async () => {
      const { events } = await import("../events.js");

      // Add one task to claude
      events.emit("task:assigned", { taskId: "t1", agentId: "claude", timestamp: Date.now() });

      const scores = await router.scoreCandidates();

      // Claude should have a lower load score
      const claudeScore = scores.find((s) => s.agentId === "claude");
      expect(claudeScore).toBeDefined();
      expect(claudeScore!.reasons.some((r) => r.includes("load") && r.includes("1/2"))).toBe(true);
    });
  });

  describe("hasCapableAgent", () => {
    it("returns true when capable agents exist", () => {
      const has = router.hasCapableAgent({
        requiredCapabilities: ["javascript"],
      });

      expect(has).toBe(true);
    });

    it("returns false when no capable agents exist", () => {
      const has = router.hasCapableAgent({
        requiredCapabilities: ["nonexistent-capability-xyz"],
      });

      expect(has).toBe(false);
    });

    it("returns true with no hints when agents exist", () => {
      const has = router.hasCapableAgent();

      expect(has).toBe(true);
    });
  });

  describe("getAgentRouting", () => {
    it("returns routing config for registered agent", () => {
      const routing = router.getAgentRouting("claude");

      expect(routing).toBeDefined();
      expect(routing.enabled).toBe(true);
      expect(routing.capabilities).toContain("javascript");
      expect(routing.maxConcurrent).toBe(2);
    });

    it("returns default config for unknown agent", () => {
      const routing = router.getAgentRouting("unknown-agent");

      expect(routing).toBeDefined();
      expect(routing.enabled).toBe(true);
      expect(routing.capabilities).toEqual([]);
    });
  });

  describe("filtering", () => {
    it("excludes agents with routing.enabled = false", async () => {
      // This test relies on the built-in registry having all agents enabled
      // If an agent was disabled, it would be filtered out
      const scores = await router.scoreCandidates();

      // All built-in agents should be included
      expect(scores.some((s) => s.agentId === "claude")).toBe(true);
      expect(scores.some((s) => s.agentId === "gemini")).toBe(true);
      expect(scores.some((s) => s.agentId === "codex")).toBe(true);
    });

    it("requires all capabilities to match", async () => {
      // Request multiple capabilities
      const agentId = await router.routeTask({
        requiredCapabilities: ["javascript", "typescript", "react"],
      });

      // Only claude and codex have all three
      if (agentId) {
        expect(["claude", "codex"]).toContain(agentId);
      }
    });
  });
});
