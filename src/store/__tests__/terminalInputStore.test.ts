/**
 * Tests for terminalInputStore - draft input persistence across project switches
 * Issue #2137: Preserve hybrid input bar content when switching projects
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { useTerminalInputStore } from "../terminalInputStore";

describe("terminalInputStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      commandHistory: new Map(),
      historyIndex: new Map(),
      tempDraft: new Map(),
      pendingDrafts: new Map(),
      pendingDraftRevision: 0,
      stashedEditorStates: new Map(),
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

    it("should also clear pending drafts and reset revision", () => {
      useTerminalInputStore.getState().setPendingDraft("term-1", "pending", "project-a");
      useTerminalInputStore.setState((s) => ({ pendingDraftRevision: s.pendingDraftRevision + 1 }));

      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(1);
      expect(useTerminalInputStore.getState().pendingDraftRevision).toBe(1);

      useTerminalInputStore.getState().clearAllDraftInputs();

      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(0);
      expect(useTerminalInputStore.getState().pendingDraftRevision).toBe(0);
    });

    it("should clear commandHistory, historyIndex, and tempDraft", () => {
      useTerminalInputStore.getState().addToHistory("term-1", "echo hello");
      useTerminalInputStore.getState().navigateHistory("term-1", "up", "current-input");

      expect(useTerminalInputStore.getState().commandHistory.size).toBe(1);
      expect(useTerminalInputStore.getState().historyIndex.has("term-1")).toBe(true);
      expect(useTerminalInputStore.getState().tempDraft.has("term-1")).toBe(true);

      useTerminalInputStore.getState().clearAllDraftInputs();

      expect(useTerminalInputStore.getState().commandHistory.size).toBe(0);
      expect(useTerminalInputStore.getState().historyIndex.size).toBe(0);
      expect(useTerminalInputStore.getState().tempDraft.size).toBe(0);
    });
  });

  describe("stashed editor states", () => {
    function makeState(doc: string) {
      return EditorState.create({ doc });
    }

    it("should stash and pop an EditorState", () => {
      const state = makeState("hello world");
      useTerminalInputStore.getState().stashEditorState("term-1", state, "project-a");
      expect(useTerminalInputStore.getState().hasStashedEditorState("term-1", "project-a")).toBe(
        true
      );

      const popped = useTerminalInputStore.getState().popStashedEditorState("term-1", "project-a");
      expect(popped).toBe(state);
      expect(useTerminalInputStore.getState().hasStashedEditorState("term-1", "project-a")).toBe(
        false
      );
    });

    it("should return undefined when popping non-existent stash", () => {
      const popped = useTerminalInputStore.getState().popStashedEditorState("term-1", "project-a");
      expect(popped).toBeUndefined();
    });

    it("should scope stash by project", () => {
      const stateA = makeState("project a content");
      const stateB = makeState("project b content");
      const store = useTerminalInputStore.getState();
      store.stashEditorState("term-1", stateA, "project-a");
      store.stashEditorState("term-1", stateB, "project-b");

      expect(useTerminalInputStore.getState().popStashedEditorState("term-1", "project-a")).toBe(
        stateA
      );
      expect(useTerminalInputStore.getState().popStashedEditorState("term-1", "project-b")).toBe(
        stateB
      );
    });

    it("should overwrite stash on re-stash", () => {
      const first = makeState("first");
      const second = makeState("second");
      const store = useTerminalInputStore.getState();
      store.stashEditorState("term-1", first, "project-a");
      store.stashEditorState("term-1", second, "project-a");

      const popped = useTerminalInputStore.getState().popStashedEditorState("term-1", "project-a");
      expect(popped).toBe(second);
    });

    it("should be cleared by clearAllDraftInputs", () => {
      const store = useTerminalInputStore.getState();
      store.stashEditorState("term-1", makeState("content"), "project-a");
      expect(useTerminalInputStore.getState().stashedEditorStates.size).toBe(1);

      useTerminalInputStore.getState().clearAllDraftInputs();
      expect(useTerminalInputStore.getState().stashedEditorStates.size).toBe(0);
    });
  });

  describe("pending drafts (option prompt preservation)", () => {
    it("should store and retrieve a pending draft", () => {
      const store = useTerminalInputStore.getState();
      store.setPendingDraft("term-1", "fix the bug", "project-a");

      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(1);

      const value = useTerminalInputStore.getState().popPendingDraft("term-1", "project-a");
      expect(value).toBe("fix the bug");
      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(0);
    });

    it("should return undefined when popping non-existent pending draft", () => {
      const value = useTerminalInputStore.getState().popPendingDraft("term-1", "project-a");
      expect(value).toBeUndefined();
    });

    it("should scope pending drafts by project", () => {
      const store = useTerminalInputStore.getState();
      store.setPendingDraft("term-1", "draft-a", "project-a");
      store.setPendingDraft("term-1", "draft-b", "project-b");

      expect(useTerminalInputStore.getState().popPendingDraft("term-1", "project-a")).toBe(
        "draft-a"
      );
      expect(useTerminalInputStore.getState().popPendingDraft("term-1", "project-b")).toBe(
        "draft-b"
      );
    });

    it("should clear a specific pending draft without affecting others", () => {
      const store = useTerminalInputStore.getState();
      store.setPendingDraft("term-1", "draft-1", "project-a");
      store.setPendingDraft("term-2", "draft-2", "project-a");

      useTerminalInputStore.getState().clearPendingDraft("term-1", "project-a");

      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(1);
      expect(useTerminalInputStore.getState().popPendingDraft("term-2", "project-a")).toBe(
        "draft-2"
      );
    });

    it("should overwrite existing pending draft on re-save", () => {
      const store = useTerminalInputStore.getState();
      store.setPendingDraft("term-1", "first", "project-a");
      store.setPendingDraft("term-1", "second", "project-a");

      expect(useTerminalInputStore.getState().popPendingDraft("term-1", "project-a")).toBe(
        "second"
      );
    });
  });

  describe("clearTerminalState", () => {
    function makeState(doc: string) {
      return EditorState.create({ doc });
    }

    it("should clear all 6 maps for the given terminal", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft", "project-a");
      store.setPendingDraft("term-1", "pending", "project-a");
      store.stashEditorState("term-1", makeState("stashed"), "project-a");
      store.addToHistory("term-1", "echo hello");
      store.navigateHistory("term-1", "up", "current");

      const before = useTerminalInputStore.getState();
      expect(before.draftInputs.size).toBe(1);
      expect(before.pendingDrafts.size).toBe(1);
      expect(before.stashedEditorStates.size).toBe(1);
      expect(before.commandHistory.has("term-1")).toBe(true);
      expect(before.historyIndex.has("term-1")).toBe(true);
      expect(before.tempDraft.has("term-1")).toBe(true);

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.draftInputs.size).toBe(0);
      expect(after.pendingDrafts.size).toBe(0);
      expect(after.stashedEditorStates.size).toBe(0);
      expect(after.commandHistory.has("term-1")).toBe(false);
      expect(after.historyIndex.has("term-1")).toBe(false);
      expect(after.tempDraft.has("term-1")).toBe(false);
    });

    it("should clear cross-project composite keys for the terminal", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-a", "project-a");
      store.setDraftInput("term-1", "draft-b", "project-b");
      store.setPendingDraft("term-1", "pending-a", "project-a");
      store.setPendingDraft("term-1", "pending-b", "project-b");
      store.stashEditorState("term-1", makeState("a"), "project-a");
      store.stashEditorState("term-1", makeState("b"), "project-b");

      expect(useTerminalInputStore.getState().draftInputs.size).toBe(2);
      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(2);
      expect(useTerminalInputStore.getState().stashedEditorStates.size).toBe(2);

      useTerminalInputStore.getState().clearTerminalState("term-1");

      expect(useTerminalInputStore.getState().draftInputs.size).toBe(0);
      expect(useTerminalInputStore.getState().pendingDrafts.size).toBe(0);
      expect(useTerminalInputStore.getState().stashedEditorStates.size).toBe(0);
    });

    it("should not affect entries for a different terminal across all 6 maps", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-1", "project-a");
      store.setDraftInput("term-2", "draft-2", "project-a");
      store.setPendingDraft("term-1", "p1", "project-a");
      store.setPendingDraft("term-2", "p2", "project-a");
      store.stashEditorState("term-1", makeState("s1"), "project-a");
      store.stashEditorState("term-2", makeState("s2"), "project-a");
      store.addToHistory("term-1", "cmd-1");
      store.addToHistory("term-2", "cmd-2");
      store.navigateHistory("term-1", "up", "");
      store.navigateHistory("term-2", "up", "");

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-2", "project-a")).toBe("draft-2");
      expect(after.commandHistory.get("term-2")).toEqual(["cmd-2"]);
      expect(after.pendingDrafts.size).toBe(1);
      expect(after.hasStashedEditorState("term-2", "project-a")).toBe(true);
      expect(after.historyIndex.has("term-2")).toBe(true);
      expect(after.tempDraft.has("term-2")).toBe(true);
    });

    it("should not delete entries for terminal IDs that are substrings (term-1 vs term-10)", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-1", "project-a");
      store.setDraftInput("term-10", "draft-10", "project-a");
      store.addToHistory("term-1", "cmd-1");
      store.addToHistory("term-10", "cmd-10");

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-10", "project-a")).toBe("draft-10");
      expect(after.commandHistory.get("term-10")).toEqual(["cmd-10"]);
      expect(after.getDraftInput("term-1", "project-a")).toBe("");
      expect(after.commandHistory.has("term-1")).toBe(false);
    });

    it("should be a no-op for a nonexistent terminal in a populated store", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-2", "draft", "project-a");
      store.addToHistory("term-2", "cmd");

      const before = useTerminalInputStore.getState();
      useTerminalInputStore.getState().clearTerminalState("nonexistent");
      const after = useTerminalInputStore.getState();

      expect(after).toBe(before);
    });

    it("should clear legacy bare-key entries (no project context)", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "legacy-draft");
      store.setPendingDraft("term-1", "legacy-pending");
      store.stashEditorState("term-1", makeState("legacy"));

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.draftInputs.size).toBe(0);
      expect(after.pendingDrafts.size).toBe(0);
      expect(after.stashedEditorStates.size).toBe(0);
    });
  });
});
