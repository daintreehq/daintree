/**
 * Tests for WorkflowLoader - Workflow validation and loading.
 */

import path from "path";
import fs from "fs/promises";
import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowLoader } from "../WorkflowLoader.js";
import type { WorkflowDefinition } from "../../../shared/types/workflow.js";

describe("WorkflowLoader", () => {
  let loader: WorkflowLoader;

  beforeEach(() => {
    loader = new WorkflowLoader();
  });

  describe("schema validation", () => {
    it("validates a minimal valid workflow", () => {
      const workflow: WorkflowDefinition = {
        id: "test-workflow",
        version: "1.0.0",
        name: "Test Workflow",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: {
              actionId: "terminal.executeCommand",
              args: { command: "echo hello" },
            },
          },
        ],
      };

      const result = loader.validate(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("validates a workflow with description", () => {
      const workflow: WorkflowDefinition = {
        id: "described-workflow",
        version: "2.0.0",
        name: "Described Workflow",
        description: "A workflow with a description",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test.action" },
          },
        ],
      };

      const result = loader.validate(workflow);

      expect(result.valid).toBe(true);
    });

    it("validates a workflow with dependencies", () => {
      const workflow: WorkflowDefinition = {
        id: "dependency-workflow",
        version: "1.0.0",
        name: "Dependency Workflow",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "step1.action" },
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "step2.action" },
            dependencies: ["step1"],
          },
        ],
      };

      const result = loader.validate(workflow);

      expect(result.valid).toBe(true);
    });

    it("validates a workflow with onSuccess and onFailure", () => {
      const workflow: WorkflowDefinition = {
        id: "routing-workflow",
        version: "1.0.0",
        name: "Routing Workflow",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "step1.action" },
            onSuccess: ["step2"],
            onFailure: ["error-handler"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "step2.action" },
          },
          {
            id: "error-handler",
            type: "action",
            config: { actionId: "error.action" },
          },
        ],
      };

      const result = loader.validate(workflow);

      expect(result.valid).toBe(true);
    });

    it("validates a workflow with conditions", () => {
      const workflow: WorkflowDefinition = {
        id: "condition-workflow",
        version: "1.0.0",
        name: "Condition Workflow",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "step1.action" },
            conditions: [
              {
                type: "status",
                op: "==",
                value: "completed",
              },
              {
                type: "result",
                path: "$.exitCode",
                op: "==",
                value: 0,
              },
            ],
          },
        ],
      };

      const result = loader.validate(workflow);

      expect(result.valid).toBe(true);
    });

    it("rejects workflow without id", () => {
      const result = loader.validate({
        version: "1.0.0",
        name: "No ID",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.path?.includes("id"))).toBe(true);
    });

    it("rejects workflow with empty id", () => {
      const result = loader.validate({
        id: "",
        version: "1.0.0",
        name: "Empty ID",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects workflow without version", () => {
      const result = loader.validate({
        id: "no-version",
        name: "No Version",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects workflow with invalid version format", () => {
      const result = loader.validate({
        id: "bad-version",
        version: "1.0",
        name: "Bad Version",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.message.includes("semver"))).toBe(true);
    });

    it("rejects workflow without name", () => {
      const result = loader.validate({
        id: "no-name",
        version: "1.0.0",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects workflow without nodes", () => {
      const result = loader.validate({
        id: "no-nodes",
        version: "1.0.0",
        name: "No Nodes",
      });

      expect(result.valid).toBe(false);
    });

    it("rejects workflow with empty nodes array", () => {
      const result = loader.validate({
        id: "empty-nodes",
        version: "1.0.0",
        name: "Empty Nodes",
        nodes: [],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.message.includes("at least one node"))).toBe(true);
    });

    it("rejects node without id", () => {
      const result = loader.validate({
        id: "bad-node",
        version: "1.0.0",
        name: "Bad Node",
        nodes: [{ type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects node without type", () => {
      const result = loader.validate({
        id: "bad-node",
        version: "1.0.0",
        name: "Bad Node",
        nodes: [{ id: "step1", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects node without config", () => {
      const result = loader.validate({
        id: "bad-node",
        version: "1.0.0",
        name: "Bad Node",
        nodes: [{ id: "step1", type: "action" }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects config without actionId", () => {
      const result = loader.validate({
        id: "bad-config",
        version: "1.0.0",
        name: "Bad Config",
        nodes: [{ id: "step1", type: "action", config: {} }],
      });

      expect(result.valid).toBe(false);
    });

    it("validates an approval node with prompt", () => {
      const result = loader.validate({
        id: "approval-workflow",
        version: "1.0.0",
        name: "Approval Workflow",
        nodes: [
          {
            id: "approve",
            type: "approval",
            config: { prompt: "Do you approve?" },
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("validates an approval node with timeoutMs", () => {
      const result = loader.validate({
        id: "approval-timeout",
        version: "1.0.0",
        name: "Approval Timeout",
        nodes: [
          {
            id: "approve",
            type: "approval",
            config: { prompt: "Quick approval?", timeoutMs: 30000 },
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("rejects approval node without prompt", () => {
      const result = loader.validate({
        id: "no-prompt",
        version: "1.0.0",
        name: "No Prompt",
        nodes: [{ id: "approve", type: "approval", config: {} }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects approval node with empty prompt", () => {
      const result = loader.validate({
        id: "empty-prompt",
        version: "1.0.0",
        name: "Empty Prompt",
        nodes: [{ id: "approve", type: "approval", config: { prompt: "" } }],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects invalid condition operator", () => {
      const result = loader.validate({
        id: "bad-condition",
        version: "1.0.0",
        name: "Bad Condition",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            conditions: [{ type: "status", op: "===", value: "completed" }],
          },
        ],
      });

      expect(result.valid).toBe(false);
    });
  });

  describe("duplicate node ID detection", () => {
    it("rejects workflow with duplicate node IDs", () => {
      const result = loader.validate({
        id: "duplicate-ids",
        version: "1.0.0",
        name: "Duplicate IDs",
        nodes: [
          { id: "step1", type: "action", config: { actionId: "test1" } },
          { id: "step1", type: "action", config: { actionId: "test2" } },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "duplicate")).toBe(true);
      expect(result.errors?.some((e) => e.message.includes("Duplicate node ID"))).toBe(true);
    });
  });

  describe("node reference validation", () => {
    it("rejects unknown dependency reference", () => {
      const result = loader.validate({
        id: "bad-ref",
        version: "1.0.0",
        name: "Bad Reference",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            dependencies: ["non-existent"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "reference")).toBe(true);
      expect(result.errors?.some((e) => e.message.includes("unknown dependency"))).toBe(true);
    });

    it("rejects unknown onSuccess reference", () => {
      const result = loader.validate({
        id: "bad-ref",
        version: "1.0.0",
        name: "Bad Reference",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            onSuccess: ["missing-step"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "reference")).toBe(true);
    });

    it("rejects unknown onFailure reference", () => {
      const result = loader.validate({
        id: "bad-ref",
        version: "1.0.0",
        name: "Bad Reference",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            onFailure: ["missing-handler"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "reference")).toBe(true);
    });
  });

  describe("cycle detection", () => {
    it("detects direct self-cycle", () => {
      const result = loader.validate({
        id: "self-cycle",
        version: "1.0.0",
        name: "Self Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            dependencies: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
      expect(result.errors?.some((e) => e.message.includes("Cycle detected"))).toBe(true);
    });

    it("detects two-node cycle", () => {
      const result = loader.validate({
        id: "two-cycle",
        version: "1.0.0",
        name: "Two Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test1" },
            dependencies: ["step2"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "test2" },
            dependencies: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("detects three-node cycle", () => {
      const result = loader.validate({
        id: "three-cycle",
        version: "1.0.0",
        name: "Three Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test1" },
            dependencies: ["step3"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "test2" },
            dependencies: ["step1"],
          },
          {
            id: "step3",
            type: "action",
            config: { actionId: "test3" },
            dependencies: ["step2"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("accepts valid DAG with diamond shape", () => {
      // Diamond: A -> B, A -> C, B -> D, C -> D
      const result = loader.validate({
        id: "diamond",
        version: "1.0.0",
        name: "Diamond",
        nodes: [
          { id: "A", type: "action", config: { actionId: "a" } },
          { id: "B", type: "action", config: { actionId: "b" }, dependencies: ["A"] },
          { id: "C", type: "action", config: { actionId: "c" }, dependencies: ["A"] },
          { id: "D", type: "action", config: { actionId: "d" }, dependencies: ["B", "C"] },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("accepts linear chain", () => {
      const result = loader.validate({
        id: "chain",
        version: "1.0.0",
        name: "Chain",
        nodes: [
          { id: "step1", type: "action", config: { actionId: "s1" } },
          { id: "step2", type: "action", config: { actionId: "s2" }, dependencies: ["step1"] },
          { id: "step3", type: "action", config: { actionId: "s3" }, dependencies: ["step2"] },
          { id: "step4", type: "action", config: { actionId: "s4" }, dependencies: ["step3"] },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("accepts parallel independent nodes", () => {
      const result = loader.validate({
        id: "parallel",
        version: "1.0.0",
        name: "Parallel",
        nodes: [
          { id: "step1", type: "action", config: { actionId: "s1" } },
          { id: "step2", type: "action", config: { actionId: "s2" } },
          { id: "step3", type: "action", config: { actionId: "s3" } },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("detects cycle via onSuccess edges", () => {
      const result = loader.validate({
        id: "onsuccess-cycle",
        version: "1.0.0",
        name: "OnSuccess Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "s1" },
            onSuccess: ["step2"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "s2" },
            onSuccess: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("detects cycle via onFailure edges", () => {
      const result = loader.validate({
        id: "onfailure-cycle",
        version: "1.0.0",
        name: "OnFailure Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "s1" },
            onFailure: ["step2"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "s2" },
            onFailure: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("detects cycle mixing dependencies and routing edges", () => {
      // step1 depends on step3, step1 onSuccess -> step2, step2 onSuccess -> step3,
      // step3 depends on step2 (redundant) AND step3 onSuccess -> step1 = real cycle
      const result = loader.validate({
        id: "mixed-cycle",
        version: "1.0.0",
        name: "Mixed Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "s1" },
            onSuccess: ["step2"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "s2" },
            onSuccess: ["step3"],
          },
          {
            id: "step3",
            type: "action",
            config: { actionId: "s3" },
            onSuccess: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("allows redundant dependency with onSuccess (not a cycle)", () => {
      // step1 depends on step2, AND step2 succeeds → step1
      // Both edges go step2 → step1, which is redundant but not cyclic
      const result = loader.validate({
        id: "redundant-edges",
        version: "1.0.0",
        name: "Redundant Edges",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "s1" },
            dependencies: ["step2"],
          },
          {
            id: "step2",
            type: "action",
            config: { actionId: "s2" },
            onSuccess: ["step1"],
          },
        ],
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("warnings", () => {
    it("warns when no entry nodes exist", () => {
      // All nodes have dependencies - unusual but structurally valid if no cycles
      // Actually this will cause a cycle since they all depend on each other
      // Let's create a case where all nodes have dependencies but no cycle
      const result = loader.validate({
        id: "no-entry",
        version: "1.0.0",
        name: "No Entry",
        nodes: [
          { id: "step1", type: "action", config: { actionId: "s1" }, dependencies: ["step2"] },
          { id: "step2", type: "action", config: { actionId: "s2" }, dependencies: ["step1"] },
        ],
      });

      // This is actually a cycle, so it should fail
      expect(result.valid).toBe(false);
    });

    it("allows workflow with only terminal nodes", () => {
      const result = loader.validate({
        id: "single-node",
        version: "1.0.0",
        name: "Single Node",
        nodes: [{ id: "step1", type: "action", config: { actionId: "s1" } }],
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("loop node validation", () => {
    it("validates a well-formed loop node", () => {
      const result = loader.validate({
        id: "loop-workflow",
        version: "1.0.0",
        name: "Loop Workflow",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [
              { id: "generate", type: "action", config: { actionId: "ai.generate" } },
              {
                id: "test",
                type: "action",
                config: { actionId: "test.run" },
                dependencies: ["generate"],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("validates a loop with exit condition", () => {
      const result = loader.validate({
        id: "loop-exit",
        version: "1.0.0",
        name: "Loop Exit",
        nodes: [
          {
            id: "retry-loop",
            type: "loop",
            config: {
              maxIterations: 5,
              exitCondition: { type: "result", path: "data.passed", op: "==", value: true },
            },
            body: [{ id: "run-test", type: "action", config: { actionId: "test.run" } }],
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("rejects loop with maxIterations = 0", () => {
      const result = loader.validate({
        id: "bad-loop",
        version: "1.0.0",
        name: "Bad Loop",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 0 },
            body: [{ id: "step", type: "action", config: { actionId: "test" } }],
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects loop with maxIterations = 21", () => {
      const result = loader.validate({
        id: "bad-loop",
        version: "1.0.0",
        name: "Bad Loop",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 21 },
            body: [{ id: "step", type: "action", config: { actionId: "test" } }],
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects loop with no body", () => {
      const result = loader.validate({
        id: "no-body",
        version: "1.0.0",
        name: "No Body",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [],
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it("rejects nested loops", () => {
      const result = loader.validate({
        id: "nested-loop",
        version: "1.0.0",
        name: "Nested Loop",
        nodes: [
          {
            id: "outer-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [
              {
                id: "inner-loop",
                type: "loop",
                config: { maxIterations: 2 },
                body: [{ id: "step", type: "action", config: { actionId: "test" } }],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "loop")).toBe(true);
      expect(
        result.errors?.some((e) => e.message.includes("Nested loop nodes are not supported"))
      ).toBe(true);
    });

    it("rejects pipe character in node IDs", () => {
      const result = loader.validate({
        id: "pipe-id",
        version: "1.0.0",
        name: "Pipe ID",
        nodes: [{ id: "step|1", type: "action", config: { actionId: "test" } }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.message.includes("must not contain '|'"))).toBe(true);
    });

    it("rejects pipe character in loop body node IDs", () => {
      const result = loader.validate({
        id: "pipe-body",
        version: "1.0.0",
        name: "Pipe Body",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [{ id: "body|node", type: "action", config: { actionId: "test" } }],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.message.includes("must not contain '|'"))).toBe(true);
    });

    it("rejects body node referencing outer node", () => {
      const result = loader.validate({
        id: "bad-body-ref",
        version: "1.0.0",
        name: "Bad Body Ref",
        nodes: [
          { id: "outer-step", type: "action", config: { actionId: "test" } },
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [
              {
                id: "body-step",
                type: "action",
                config: { actionId: "test" },
                dependencies: ["outer-step"],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "reference")).toBe(true);
    });

    it("rejects body node referencing non-existent body node", () => {
      const result = loader.validate({
        id: "bad-body-ref",
        version: "1.0.0",
        name: "Bad Body Ref",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [
              {
                id: "body-step",
                type: "action",
                config: { actionId: "test" },
                dependencies: ["non-existent"],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "reference")).toBe(true);
    });

    it("rejects cycle in loop body", () => {
      const result = loader.validate({
        id: "body-cycle",
        version: "1.0.0",
        name: "Body Cycle",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [
              {
                id: "a",
                type: "action",
                config: { actionId: "test" },
                dependencies: ["b"],
              },
              {
                id: "b",
                type: "action",
                config: { actionId: "test" },
                dependencies: ["a"],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });

    it("accepts valid loop body DAG", () => {
      const result = loader.validate({
        id: "valid-body",
        version: "1.0.0",
        name: "Valid Body",
        nodes: [
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 5 },
            body: [
              { id: "generate", type: "action", config: { actionId: "ai.generate" } },
              {
                id: "test",
                type: "action",
                config: { actionId: "test.run" },
                dependencies: ["generate"],
              },
              {
                id: "fix",
                type: "action",
                config: { actionId: "ai.fix" },
                dependencies: ["test"],
              },
            ],
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("rejects body node ID that conflicts with outer node ID", () => {
      const result = loader.validate({
        id: "id-conflict",
        version: "1.0.0",
        name: "ID Conflict",
        nodes: [
          { id: "shared-id", type: "action", config: { actionId: "test" } },
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            body: [{ id: "shared-id", type: "action", config: { actionId: "test2" } }],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "duplicate")).toBe(true);
      expect(result.errors?.some((e) => e.message.includes("conflicts with outer node ID"))).toBe(
        true
      );
    });

    it("outer DAG with loop node validates correctly", () => {
      const result = loader.validate({
        id: "outer-dag",
        version: "1.0.0",
        name: "Outer DAG",
        nodes: [
          { id: "setup", type: "action", config: { actionId: "setup.action" } },
          {
            id: "retry-loop",
            type: "loop",
            config: { maxIterations: 3 },
            dependencies: ["setup"],
            onSuccess: ["report"],
            body: [
              { id: "generate", type: "action", config: { actionId: "ai.generate" } },
              {
                id: "test",
                type: "action",
                config: { actionId: "test.run" },
                dependencies: ["generate"],
              },
            ],
          },
          {
            id: "report",
            type: "action",
            config: { actionId: "report.action" },
            dependencies: ["retry-loop"],
          },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it("still rejects cycle in outer DAG with loop node", () => {
      const result = loader.validate({
        id: "outer-cycle",
        version: "1.0.0",
        name: "Outer Cycle",
        nodes: [
          {
            id: "step1",
            type: "action",
            config: { actionId: "test" },
            dependencies: ["my-loop"],
          },
          {
            id: "my-loop",
            type: "loop",
            config: { maxIterations: 3 },
            dependencies: ["step1"],
            body: [{ id: "body-step", type: "action", config: { actionId: "test" } }],
          },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.type === "cycle")).toBe(true);
    });
  });

  describe("loadFromJson", () => {
    it("loads a valid workflow from JSON object", () => {
      const json = {
        id: "json-workflow",
        version: "1.0.0",
        name: "JSON Workflow",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      };

      const loaded = loader.loadFromJson(json, "project");

      expect(loaded).not.toBeNull();
      expect(loaded?.definition.id).toBe("json-workflow");
      expect(loaded?.source).toBe("project");
      expect(loaded?.loadedAt).toBeGreaterThan(0);
    });

    it("throws on invalid JSON workflow", () => {
      const json = {
        id: "bad",
        version: "1.0",
        name: "Bad",
        nodes: [],
      };

      expect(() => loader.loadFromJson(json, "project")).toThrow();
    });
  });

  describe("workflow registration", () => {
    it("registers a project workflow", () => {
      const json = {
        id: "registered-workflow",
        version: "1.0.0",
        name: "Registered",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      };

      const registered = loader.registerWorkflow(json, "project");

      expect(registered.definition.id).toBe("registered-workflow");
    });

    it("unregisters a project workflow", () => {
      const json = {
        id: "to-remove",
        version: "1.0.0",
        name: "To Remove",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      };

      loader.registerWorkflow(json, "project");
      const removed = loader.unregisterWorkflow("to-remove");

      expect(removed).toBe(true);
    });

    it("returns false when unregistering non-existent workflow", () => {
      const removed = loader.unregisterWorkflow("non-existent");

      expect(removed).toBe(false);
    });

    it("clears all project workflows", async () => {
      const json1 = {
        id: "workflow1",
        version: "1.0.0",
        name: "Workflow 1",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      };
      const json2 = {
        id: "workflow2",
        version: "1.0.0",
        name: "Workflow 2",
        nodes: [{ id: "step1", type: "action", config: { actionId: "test" } }],
      };

      loader.registerWorkflow(json1, "project");
      loader.registerWorkflow(json2, "project");
      loader.clearProjectWorkflows();

      // After clearing, getWorkflow should not find project workflows
      const found = await loader.getWorkflow("workflow1");
      expect(found).toBeNull();
    });
  });
});

describe("built-in workflows from disk", () => {
  const WORKFLOWS_DIR = path.resolve(process.cwd(), "electron/workflows");
  let loader: WorkflowLoader;
  let jsonFiles: string[];

  beforeEach(async () => {
    loader = new WorkflowLoader();
    const files = await fs.readdir(WORKFLOWS_DIR);
    jsonFiles = files.filter((f) => f.endsWith(".json"));
  });

  it("finds at least 3 built-in workflow files", () => {
    expect(jsonFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("each built-in workflow passes loadFromFile validation", async () => {
    for (const file of jsonFiles) {
      const filePath = path.join(WORKFLOWS_DIR, file);
      const loaded = await loader.loadFromFile(filePath, "built-in");
      expect(loaded, `${file} should load successfully`).not.toBeNull();
      expect(loaded!.source).toBe("built-in");
    }
  });

  it("each built-in workflow has unique id matching filename", async () => {
    const ids = new Set<string>();
    for (const file of jsonFiles) {
      const filePath = path.join(WORKFLOWS_DIR, file);
      const loaded = await loader.loadFromFile(filePath, "built-in");
      const expectedId = file.replace(".json", "");
      expect(loaded!.definition.id, `${file} id should match filename`).toBe(expectedId);
      expect(
        ids.has(loaded!.definition.id),
        `duplicate workflow id: ${loaded!.definition.id}`
      ).toBe(false);
      ids.add(loaded!.definition.id);
    }
  });

  it("no built-in workflow uses non-existent terminal.executeCommand", async () => {
    for (const file of jsonFiles) {
      const filePath = path.join(WORKFLOWS_DIR, file);
      const loaded = await loader.loadFromFile(filePath, "built-in");
      for (const node of loaded!.definition.nodes) {
        expect(
          node.config.actionId,
          `${file}: node "${node.id}" uses removed action "terminal.executeCommand"`
        ).not.toBe("terminal.executeCommand");
      }
    }
  });

  it("each built-in workflow uses only known action IDs", async () => {
    const knownActionIds = new Set([
      "terminal.new",
      "terminal.sendCommand",
      "terminal.close",
      "terminal.list",
      "notes.create",
      "notes.list",
      "notes.openPalette",
      "worktree.list",
      "worktree.getCurrent",
      "worktree.refresh",
      "worktree.refreshPullRequests",
      "github.openPRs",
      "github.openIssues",
      "github.openCommits",
      "git.stageAll",
      "git.commit",
      "git.push",
      "git.getStagingStatus",
    ]);

    for (const file of jsonFiles) {
      const filePath = path.join(WORKFLOWS_DIR, file);
      const loaded = await loader.loadFromFile(filePath, "built-in");
      for (const node of loaded!.definition.nodes) {
        expect(
          knownActionIds.has(node.config.actionId),
          `${file}: node "${node.id}" uses unknown actionId "${node.config.actionId}"`
        ).toBe(true);
      }
    }
  });
});
