/**
 * Tests for terminalInputStore - draft input persistence across project switches
 * Issue #2137: Preserve hybrid input bar content when switching projects
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalInputStore } from "../terminalInputStore";

describe("terminalInputStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      commandHistory: new Map(),
      historyIndex: new Map(),
      tempDraft: new Map(),
    });
  });

  describe("draft inputs with project context", () => {
    it("should store draft input with project context", () => {
      const terminalId = "term-1";
      const projectId = "project-a";
      const draft = "echo hello";

      useTerminalInputStore.getState().setDraftInput(terminalId, draft, projectId);

      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectId)).toBe(draft);
    });

    it("should keep draft inputs separate per project", () => {
      const terminalId = "term-1";
      const projectA = "project-a";
      const projectB = "project-b";
      const draftA = "echo project-a";
      const draftB = "echo project-b";

      useTerminalInputStore.getState().setDraftInput(terminalId, draftA, projectA);
      useTerminalInputStore.getState().setDraftInput(terminalId, draftB, projectB);

      // Same terminal ID, different projects should have different drafts
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectA)).toBe(draftA);
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectB)).toBe(draftB);
    });

    it("should preserve draft when switching projects and back", () => {
      const terminalId = "term-1";
      const projectA = "project-a";
      const projectB = "project-b";
      const draftA = "npm run dev";

      // Set draft in project A
      useTerminalInputStore.getState().setDraftInput(terminalId, draftA, projectA);

      // "Switch" to project B - draft from project A should not be visible
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectB)).toBe("");

      // "Switch" back to project A - draft should be preserved
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectA)).toBe(draftA);
    });

    it("should clear draft input with project context", () => {
      const terminalId = "term-1";
      const projectId = "project-a";
      const draft = "echo hello";

      useTerminalInputStore.getState().setDraftInput(terminalId, draft, projectId);
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectId)).toBe(draft);

      useTerminalInputStore.getState().clearDraftInput(terminalId, projectId);
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectId)).toBe("");
    });

    it("should not affect other project drafts when clearing", () => {
      const terminalId = "term-1";
      const projectA = "project-a";
      const projectB = "project-b";
      const draftA = "echo project-a";
      const draftB = "echo project-b";

      useTerminalInputStore.getState().setDraftInput(terminalId, draftA, projectA);
      useTerminalInputStore.getState().setDraftInput(terminalId, draftB, projectB);

      // Clear draft for project A only
      useTerminalInputStore.getState().clearDraftInput(terminalId, projectA);

      // Project A draft should be cleared
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectA)).toBe("");
      // Project B draft should be preserved
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectB)).toBe(draftB);
    });

    it("should clear empty drafts to avoid memory leaks", () => {
      const terminalId = "term-1";
      const projectId = "project-a";

      // Set a draft
      useTerminalInputStore.getState().setDraftInput(terminalId, "hello", projectId);
      expect(useTerminalInputStore.getState().draftInputs.size).toBe(1);

      // Set to empty string should delete the entry
      useTerminalInputStore.getState().setDraftInput(terminalId, "", projectId);
      expect(useTerminalInputStore.getState().draftInputs.size).toBe(0);
    });
  });

  describe("backward compatibility without project context", () => {
    it("should work without project context (legacy behavior)", () => {
      const terminalId = "term-1";
      const draft = "echo hello";

      // Call without projectId
      useTerminalInputStore.getState().setDraftInput(terminalId, draft);
      expect(useTerminalInputStore.getState().getDraftInput(terminalId)).toBe(draft);
    });

    it("should keep drafts with and without project context separate", () => {
      const terminalId = "term-1";
      const projectId = "project-a";
      const draftWithProject = "echo with-project";
      const draftWithoutProject = "echo without-project";

      useTerminalInputStore.getState().setDraftInput(terminalId, draftWithProject, projectId);
      useTerminalInputStore.getState().setDraftInput(terminalId, draftWithoutProject);

      // These should be stored under different keys
      expect(useTerminalInputStore.getState().getDraftInput(terminalId, projectId)).toBe(
        draftWithProject
      );
      expect(useTerminalInputStore.getState().getDraftInput(terminalId)).toBe(draftWithoutProject);
    });
  });

  describe("multiple terminals per project", () => {
    it("should store separate drafts for different terminals in same project", () => {
      const projectId = "project-a";
      const terminal1 = "term-1";
      const terminal2 = "term-2";
      const draft1 = "npm install";
      const draft2 = "npm test";

      useTerminalInputStore.getState().setDraftInput(terminal1, draft1, projectId);
      useTerminalInputStore.getState().setDraftInput(terminal2, draft2, projectId);

      expect(useTerminalInputStore.getState().getDraftInput(terminal1, projectId)).toBe(draft1);
      expect(useTerminalInputStore.getState().getDraftInput(terminal2, projectId)).toBe(draft2);
    });

    it("should track multiple terminals across multiple projects", () => {
      const projectA = "project-a";
      const projectB = "project-b";
      const terminal1 = "term-1";
      const terminal2 = "term-2";

      useTerminalInputStore.getState().setDraftInput(terminal1, "a-t1", projectA);
      useTerminalInputStore.getState().setDraftInput(terminal2, "a-t2", projectA);
      useTerminalInputStore.getState().setDraftInput(terminal1, "b-t1", projectB);
      useTerminalInputStore.getState().setDraftInput(terminal2, "b-t2", projectB);

      expect(useTerminalInputStore.getState().getDraftInput(terminal1, projectA)).toBe("a-t1");
      expect(useTerminalInputStore.getState().getDraftInput(terminal2, projectA)).toBe("a-t2");
      expect(useTerminalInputStore.getState().getDraftInput(terminal1, projectB)).toBe("b-t1");
      expect(useTerminalInputStore.getState().getDraftInput(terminal2, projectB)).toBe("b-t2");
    });
  });

  describe("clearAllDraftInputs", () => {
    it("should clear all draft inputs including project-scoped ones", () => {
      const projectA = "project-a";
      const projectB = "project-b";

      useTerminalInputStore.getState().setDraftInput("term-1", "draft-1", projectA);
      useTerminalInputStore.getState().setDraftInput("term-2", "draft-2", projectB);
      useTerminalInputStore.getState().setDraftInput("term-3", "draft-3"); // no project

      expect(useTerminalInputStore.getState().draftInputs.size).toBe(3);

      useTerminalInputStore.getState().clearAllDraftInputs();

      expect(useTerminalInputStore.getState().draftInputs.size).toBe(0);
      expect(useTerminalInputStore.getState().getDraftInput("term-1", projectA)).toBe("");
      expect(useTerminalInputStore.getState().getDraftInput("term-2", projectB)).toBe("");
      expect(useTerminalInputStore.getState().getDraftInput("term-3")).toBe("");
    });
  });
});
