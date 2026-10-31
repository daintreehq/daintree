/**
 * Tests for terminalInputStore - draft input persistence across project switches
 * Issue #2137: Preserve hybrid input bar content when switching projects
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { useTerminalInputStore } from "../terminalInputStore";
import { getViewWorkspaceId } from "../viewWorkspaceId";
import { VOICE_RECENT_PROMPT_MAX_CHARS } from "@shared/config/voiceCorrection";

vi.mock("../viewWorkspaceId", () => ({ getViewWorkspaceId: vi.fn(() => null) }));

describe("terminalInputStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      commandHistory: new Map(),
      sentPrompts: new Map(),
      historyIndex: new Map(),
      tempDraft: new Map(),
      pendingDrafts: new Map(),
      pendingDraftRevision: 0,
      stashedEditorStates: new Map(),
      fleetDraftHolds: new Map(),
      externalDraftRevision: 0,
      lastTypedAgentTarget: null,
    });
    vi.mocked(getViewWorkspaceId).mockReturnValue(null);
  });

  describe("fleet draft holds (#14949)", () => {
    const P = "proj-1";
    const fleet = (...ids: string[]) => new Set(ids);
    const draft = (id: string) => useTerminalInputStore.getState().getDraftInput(id, P);
    const hold = (id: string) => useTerminalInputStore.getState().fleetDraftHolds.get(`${P}:${id}`);

    it("holds a follower's own draft the first time the fleet's replaces it", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("a", "shared", P);
      store.setDraftInput("b", "b's own", P);

      store.mirrorFleetDraft("a", "shared", fleet("a", "b"), P);
      store.mirrorFleetDraft("a", "shared, edited", fleet("a", "b"), P);

      expect(draft("b")).toBe("shared, edited");
      expect(hold("b")).toEqual({ terminalId: "b", draft: "b's own" });
    });

    it("holds an empty draft, and takes an empty primary's draft over a follower's", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("b", "b's own", P);

      store.mirrorFleetDraft("a", "", fleet("a", "b"), P);
      expect(useTerminalInputStore.getState().draftInputs.has(`${P}:b`)).toBe(false);
      store.mirrorFleetDraft("a", "x", fleet("a", "b", "c"), P);

      expect(draft("b")).toBe("x");
      expect(hold("b")?.draft).toBe("b's own");
      expect(hold("c")?.draft).toBe("");
    });

    it("holds nothing for a primary: its draft is the fleet's", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("a", "a's draft", P);
      store.setDraftInput("b", "b's own", P);
      store.mirrorFleetDraft("a", "a's draft", fleet("a", "b"), P);

      // B takes focus and edits the fleet's draft, which reaches A.
      store.mirrorFleetDraft("b", "a's draft, edited in b", fleet("a", "b"), P);
      store.releaseFleetDraftHolds(fleet());

      expect(draft("a")).toBe("a's draft, edited in b");
      expect(draft("b")).toBe("b's own");
    });

    it("leaves the store untouched when the fleet's draft is already everywhere", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("a", "same", P);
      store.setDraftInput("b", "same", P);
      store.mirrorFleetDraft("a", "same", fleet("a", "b"), P);
      const before = useTerminalInputStore.getState();

      store.mirrorFleetDraft("a", "same", fleet("a", "b"), P);

      expect(useTerminalInputStore.getState()).toBe(before);
      expect(hold("b")).toBeUndefined();
    });

    it("gives back only the drafts of members no longer in the fleet", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("b", "b's own", P);
      store.setDraftInput("c", "c's own", P);
      store.mirrorFleetDraft("a", "shared", fleet("a", "b", "c"), P);

      store.releaseFleetDraftHolds(fleet("a", "c"));

      expect(draft("b")).toBe("b's own");
      expect(hold("b")).toBeUndefined();
      expect(draft("c")).toBe("shared");
      expect(hold("c")?.draft).toBe("c's own");
      expect(hold("a")?.draft).toBeNull();
    });

    it("gives an empty draft back as no draft", () => {
      const store = useTerminalInputStore.getState();
      store.mirrorFleetDraft("a", "shared", fleet("a", "b"), P);

      store.releaseFleetDraftHolds(fleet());

      expect(useTerminalInputStore.getState().draftInputs.has(`${P}:b`)).toBe(false);
      expect(useTerminalInputStore.getState().fleetDraftHolds.size).toBe(0);
    });

    it("drops the hold when the pane already shows its own draft again", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("b", "b's own", P);
      store.mirrorFleetDraft("a", "shared", fleet("a", "b"), P);
      store.setDraftInput("b", "b's own", P);

      store.releaseFleetDraftHolds(fleet());

      expect(hold("b")).toBeUndefined();
      expect(draft("b")).toBe("b's own");
    });

    // An empty primary leaves B nothing in the draft map: the hold is all it has.
    function holdUnderEmptyFleetDraft(): void {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("b", "b's own", P);
      store.setDraftInput("c", "c's own", P);
      store.mirrorFleetDraft("a", "", fleet("a", "b", "c"), P);
      store.setDraftInput("d", "d's own", "proj-2");
      store.mirrorFleetDraft("e", "", fleet("e", "d"), "proj-2");
    }

    it("drops a closed terminal's hold without giving its draft back", () => {
      holdUnderEmptyFleetDraft();
      const store = useTerminalInputStore.getState();

      store.clearTerminalState("b");

      expect(hold("b")).toBeUndefined();
      expect(hold("c")?.draft).toBe("c's own");
      store.releaseFleetDraftHolds(fleet());
      expect(draft("b")).toBe("");
      expect(draft("c")).toBe("c's own");
    });

    it("drops a project's holds on a switch, keeping preserved terminals' and other projects'", () => {
      holdUnderEmptyFleetDraft();
      const store = useTerminalInputStore.getState();

      store.resetForProjectSwitch(P, new Set(["c"]));

      expect(hold("b")).toBeUndefined();
      expect(hold("c")?.draft).toBe("c's own");
      expect(useTerminalInputStore.getState().fleetDraftHolds.get("proj-2:d")?.draft).toBe(
        "d's own"
      );
      store.releaseFleetDraftHolds(fleet());
      expect(draft("b")).toBe("");
    });

    it("drops a hold when a newer draft is restored for the pane, and only that one", () => {
      holdUnderEmptyFleetDraft();
      const store = useTerminalInputStore.getState();

      store.restoreProjectDraftInputs(P, { b: "edited on another screen" });
      store.releaseFleetDraftHolds(fleet());

      expect(draft("b")).toBe("edited on another screen");
      expect(draft("c")).toBe("c's own");
    });

    it("drops every hold with all drafts", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("b", "b's own", P);
      store.mirrorFleetDraft("a", "shared", fleet("a", "b"), P);

      store.clearAllDraftInputs();

      expect(useTerminalInputStore.getState().fleetDraftHolds.size).toBe(0);
    });
  });

  describe("sent prompts", () => {
    const texts = (terminalId: string) =>
      useTerminalInputStore
        .getState()
        .getSentPrompts(terminalId)
        .map((prompt) => prompt.text);

    it("keeps every send in the order it went, repeats included, unlike recall history", () => {
      const store = useTerminalInputStore.getState();
      for (const text of ["fix the build", "  continue \n", "continue", "fix the build", "   "]) {
        store.addToHistory("term-1", text, "project-a");
        useTerminalInputStore.getState().recordSentPrompt("term-1", text, 1_000);
      }

      expect(texts("term-1")).toEqual(["fix the build", "continue", "continue", "fix the build"]);
      expect(useTerminalInputStore.getState().commandHistory.get("project-a:term-1")).toEqual([
        "continue",
        "fix the build",
      ]);
      expect(texts("term-2")).toEqual([]);
    });

    it("keeps the latest sends, counting every one so far", () => {
      for (let n = 0; n < 9; n++) {
        useTerminalInputStore.getState().recordSentPrompt("term-1", `prompt ${n}`, 1_000 + n * 10);
      }

      const sent = useTerminalInputStore.getState().getSentPrompts("term-1");
      expect(sent).toEqual(
        [3, 4, 5, 6, 7, 8].map((seq) => ({ text: `prompt ${seq}`, sentAt: 1_000 + seq * 10, seq }))
      );
    });

    it("takes back one send, leaving the rest and the count where they were", () => {
      const store = useTerminalInputStore.getState();
      const sent = ["one", "two", "three"].map((text) => store.recordSentPrompt("term-1", text));
      expect(sent.map((prompt) => prompt?.seq)).toEqual([0, 1, 2]);
      expect(store.recordSentPrompt("term-1", "   ")).toBeNull();

      useTerminalInputStore.getState().retractSentPrompt("term-1", sent[1]!);
      expect(texts("term-1")).toEqual(["one", "three"]);
      expect(useTerminalInputStore.getState().recordSentPrompt("term-1", "four")?.seq).toBe(3);
    });

    it("takes back nothing newer when the refused send's record was cleared first", () => {
      const pending = useTerminalInputStore.getState().recordSentPrompt("term-1", "refused late")!;
      useTerminalInputStore.getState().clearTerminalState("term-1");
      const newer = useTerminalInputStore.getState().recordSentPrompt("term-1", "landed")!;
      expect(newer.seq).toBe(pending.seq);

      useTerminalInputStore.getState().retractSentPrompt("term-1", pending);
      expect(texts("term-1")).toEqual(["landed"]);
    });

    it("keeps only the opening of a long prompt, never half a surrogate pair", () => {
      const store = useTerminalInputStore.getState();
      const opening = "x".repeat(VOICE_RECENT_PROMPT_MAX_CHARS - 2);
      store.recordSentPrompt("term-1", `${opening}😀 and the rest of a pasted log`);
      store.recordSentPrompt("term-2", "日本語".repeat(VOICE_RECENT_PROMPT_MAX_CHARS));
      const exact = "y".repeat(VOICE_RECENT_PROMPT_MAX_CHARS);
      store.recordSentPrompt("term-3", exact);

      expect(texts("term-1")).toEqual([`${opening}…`]);
      expect(texts("term-2")).toEqual([
        `${"日本語".repeat(VOICE_RECENT_PROMPT_MAX_CHARS).slice(0, VOICE_RECENT_PROMPT_MAX_CHARS - 1)}…`,
      ]);
      expect(texts("term-3")).toEqual([exact]);
    });

    it("drops the run of key characters a cut goes through (#15596)", () => {
      const store = useTerminalInputStore.getState();
      // The cut keeps `sk-proj-Q2w`, short of the prefix redaction knows a key by.
      const lead = "use this key: ".padStart(VOICE_RECENT_PROMPT_MAX_CHARS - 12, "a ");
      store.recordSentPrompt("term-1", `${lead}sk-proj-${"Q2w3E4r5".repeat(4)}`);
      // A cut at the end of a word takes nothing more.
      const whole = "b ".repeat(VOICE_RECENT_PROMPT_MAX_CHARS);
      store.recordSentPrompt("term-2", whole);

      expect(texts("term-1")).toEqual([`${lead}…`]);
      expect(texts("term-2")).toEqual([`${whole.slice(0, VOICE_RECENT_PROMPT_MAX_CHARS - 1)}…`]);
    });

    it("forgets the terminal sent to longest ago past its terminal limit", () => {
      for (let n = 0; n < 64; n++) {
        useTerminalInputStore.getState().recordSentPrompt(`term-${n}`, "hello");
      }
      useTerminalInputStore.getState().recordSentPrompt("term-0", "again");
      useTerminalInputStore.getState().recordSentPrompt("term-64", "hello");
      useTerminalInputStore.getState().recordSentPrompt("term-65", "hello");

      const keys = [...useTerminalInputStore.getState().sentPrompts.keys()];
      expect(keys).toHaveLength(64);
      expect(keys).not.toContain("term-1");
      expect(keys).not.toContain("term-2");
      expect(texts("term-0")).toEqual(["hello", "again"]);
    });

    it("is kept by the view's workspace and cleared with the terminal or the project", () => {
      vi.mocked(getViewWorkspaceId).mockReturnValue("project-a");
      const store = useTerminalInputStore.getState();
      store.recordSentPrompt("term-1", "first");
      store.recordSentPrompt("term-2", "second");

      expect([...useTerminalInputStore.getState().sentPrompts.keys()]).toEqual([
        "project-a:term-1",
        "project-a:term-2",
      ]);

      useTerminalInputStore.getState().clearTerminalState("term-1");
      expect(texts("term-1")).toEqual([]);
      expect(texts("term-2")).toEqual(["second"]);

      store.recordSentPrompt("term-3", "kept with its pane");
      vi.mocked(getViewWorkspaceId).mockReturnValue("project-b");
      store.recordSentPrompt("term-2", "another workspace's");

      useTerminalInputStore.getState().resetForProjectSwitch("project-a", new Set(["term-3"]));
      expect([...useTerminalInputStore.getState().sentPrompts.keys()]).toEqual([
        "project-a:term-3",
        "project-b:term-2",
      ]);
    });
  });

  describe("draft inputs with project context", () => {
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
      useTerminalInputStore.getState().addToHistory("term-1", "echo hello", "project-a");
      useTerminalInputStore
        .getState()
        .navigateHistory("term-1", "up", "current-input", "project-a");

      expect(useTerminalInputStore.getState().commandHistory.size).toBe(1);
      expect(useTerminalInputStore.getState().historyIndex.has("project-a:term-1")).toBe(true);
      expect(useTerminalInputStore.getState().tempDraft.has("project-a:term-1")).toBe(true);

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
      store.addToHistory("term-1", "echo hello", "project-a");
      store.navigateHistory("term-1", "up", "current", "project-a");

      const before = useTerminalInputStore.getState();
      expect(before.draftInputs.size).toBe(1);
      expect(before.pendingDrafts.size).toBe(1);
      expect(before.stashedEditorStates.size).toBe(1);
      expect(before.commandHistory.has("project-a:term-1")).toBe(true);
      expect(before.historyIndex.has("project-a:term-1")).toBe(true);
      expect(before.tempDraft.has("project-a:term-1")).toBe(true);

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.draftInputs.size).toBe(0);
      expect(after.pendingDrafts.size).toBe(0);
      expect(after.stashedEditorStates.size).toBe(0);
      expect(after.commandHistory.has("project-a:term-1")).toBe(false);
      expect(after.historyIndex.has("project-a:term-1")).toBe(false);
      expect(after.tempDraft.has("project-a:term-1")).toBe(false);
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
      store.addToHistory("term-1", "cmd-1", "project-a");
      store.addToHistory("term-2", "cmd-2", "project-a");
      store.navigateHistory("term-1", "up", "", "project-a");
      store.navigateHistory("term-2", "up", "", "project-a");

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-2", "project-a")).toBe("draft-2");
      expect(after.commandHistory.get("project-a:term-2")).toEqual(["cmd-2"]);
      expect(after.pendingDrafts.size).toBe(1);
      expect(after.hasStashedEditorState("term-2", "project-a")).toBe(true);
      expect(after.historyIndex.has("project-a:term-2")).toBe(true);
      expect(after.tempDraft.has("project-a:term-2")).toBe(true);
    });

    it("should not delete entries for terminal IDs that are substrings (term-1 vs term-10)", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-1", "project-a");
      store.setDraftInput("term-10", "draft-10", "project-a");
      store.addToHistory("term-1", "cmd-1", "project-a");
      store.addToHistory("term-10", "cmd-10", "project-a");

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-10", "project-a")).toBe("draft-10");
      expect(after.commandHistory.get("project-a:term-10")).toEqual(["cmd-10"]);
      expect(after.getDraftInput("term-1", "project-a")).toBe("");
      expect(after.commandHistory.has("project-a:term-1")).toBe(false);
    });

    it("should be a no-op for a nonexistent terminal in a populated store", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-2", "draft", "project-a");
      store.addToHistory("term-2", "cmd", "project-a");

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

    it("should clear composite-keyed history entries across all projects", () => {
      const store = useTerminalInputStore.getState();

      store.addToHistory("term-1", "cmd-a", "project-a");
      store.addToHistory("term-1", "cmd-b", "project-b");
      store.navigateHistory("term-1", "up", "", "project-a");

      expect(useTerminalInputStore.getState().commandHistory.size).toBe(2);

      useTerminalInputStore.getState().clearTerminalState("term-1");

      const after = useTerminalInputStore.getState();
      expect(after.commandHistory.size).toBe(0);
      expect(after.historyIndex.size).toBe(0);
      expect(after.tempDraft.size).toBe(0);
    });
  });

  describe("project-scoped command history", () => {
    it("should isolate history by project for the same terminal", () => {
      const store = useTerminalInputStore.getState();

      store.addToHistory("term-1", "echo project-a", "project-a");
      store.addToHistory("term-1", "echo project-b", "project-b");

      expect(store.getHistoryLength("term-1", "project-a")).toBe(1);
      expect(store.getHistoryLength("term-1", "project-b")).toBe(1);
      expect(useTerminalInputStore.getState().commandHistory.get("project-a:term-1")).toEqual([
        "echo project-a",
      ]);
      expect(useTerminalInputStore.getState().commandHistory.get("project-b:term-1")).toEqual([
        "echo project-b",
      ]);
    });

    it("should navigate history within project scope", () => {
      const store = useTerminalInputStore.getState();

      store.addToHistory("term-1", "cmd-a1", "project-a");
      store.addToHistory("term-1", "cmd-a2", "project-a");
      store.addToHistory("term-1", "cmd-b1", "project-b");

      const resultA = store.navigateHistory("term-1", "up", "current", "project-a");
      expect(resultA).toBe("cmd-a2");

      const resultB = useTerminalInputStore
        .getState()
        .navigateHistory("term-1", "up", "current", "project-b");
      expect(resultB).toBe("cmd-b1");
    });

    it("should work without projectId (backward compatibility)", () => {
      const store = useTerminalInputStore.getState();

      store.addToHistory("term-1", "bare-cmd");
      expect(store.getHistoryLength("term-1")).toBe(1);
      expect(useTerminalInputStore.getState().commandHistory.get("term-1")).toEqual(["bare-cmd"]);

      const result = useTerminalInputStore.getState().navigateHistory("term-1", "up", "current");
      expect(result).toBe("bare-cmd");
    });
  });

  describe("resetForProjectSwitch", () => {
    function makeState(doc: string) {
      return EditorState.create({ doc });
    }

    it("should remove all entries for the departing project", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-a", "project-a");
      store.setPendingDraft("term-1", "pending-a", "project-a");
      store.stashEditorState("term-1", makeState("stash-a"), "project-a");
      store.addToHistory("term-1", "cmd-a", "project-a");
      store.navigateHistory("term-1", "up", "", "project-a");

      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      const after = useTerminalInputStore.getState();
      expect(after.draftInputs.size).toBe(0);
      expect(after.pendingDrafts.size).toBe(0);
      expect(after.stashedEditorStates.size).toBe(0);
      expect(after.commandHistory.size).toBe(0);
      expect(after.historyIndex.size).toBe(0);
      expect(after.tempDraft.size).toBe(0);
    });

    it("should preserve entries from other projects", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-1", "draft-a", "project-a");
      store.setDraftInput("term-1", "draft-b", "project-b");
      store.addToHistory("term-1", "cmd-a", "project-a");
      store.addToHistory("term-1", "cmd-b", "project-b");

      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-1", "project-a")).toBe("");
      expect(after.getDraftInput("term-1", "project-b")).toBe("draft-b");
      expect(after.commandHistory.has("project-a:term-1")).toBe(false);
      expect(after.commandHistory.get("project-b:term-1")).toEqual(["cmd-b"]);
    });

    it("should respect preserveTerminalIds including navigation state", () => {
      const store = useTerminalInputStore.getState();

      store.setDraftInput("term-keep", "draft-keep", "project-a");
      store.setDraftInput("term-remove", "draft-remove", "project-a");
      store.addToHistory("term-keep", "cmd-keep", "project-a");
      store.addToHistory("term-remove", "cmd-remove", "project-a");
      store.navigateHistory("term-keep", "up", "current-keep", "project-a");
      store.navigateHistory("term-remove", "up", "current-remove", "project-a");

      useTerminalInputStore.getState().resetForProjectSwitch("project-a", new Set(["term-keep"]));

      const after = useTerminalInputStore.getState();
      expect(after.getDraftInput("term-keep", "project-a")).toBe("draft-keep");
      expect(after.getDraftInput("term-remove", "project-a")).toBe("");
      expect(after.commandHistory.has("project-a:term-keep")).toBe(true);
      expect(after.commandHistory.has("project-a:term-remove")).toBe(false);
      expect(after.historyIndex.has("project-a:term-keep")).toBe(true);
      expect(after.historyIndex.has("project-a:term-remove")).toBe(false);
      expect(after.tempDraft.has("project-a:term-keep")).toBe(true);
      expect(after.tempDraft.has("project-a:term-remove")).toBe(false);
    });

    it("should clear stale historyIndex and tempDraft from departing project", () => {
      const store = useTerminalInputStore.getState();

      store.addToHistory("term-1", "cmd-a1", "project-a");
      store.addToHistory("term-1", "cmd-a2", "project-a");
      store.navigateHistory("term-1", "up", "draft-a", "project-a");

      expect(useTerminalInputStore.getState().historyIndex.has("project-a:term-1")).toBe(true);
      expect(useTerminalInputStore.getState().tempDraft.has("project-a:term-1")).toBe(true);

      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      const after = useTerminalInputStore.getState();
      expect(after.commandHistory.size).toBe(0);
      expect(after.historyIndex.size).toBe(0);
      expect(after.tempDraft.size).toBe(0);

      after.addToHistory("term-1", "cmd-b1", "project-b");
      const result = useTerminalInputStore
        .getState()
        .navigateHistory("term-1", "up", "fresh", "project-b");
      expect(result).toBe("cmd-b1");
    });

    it("should not affect bare-key entries (no project prefix)", () => {
      const store = useTerminalInputStore.getState();
      store.addToHistory("term-1", "bare-cmd");
      store.setDraftInput("term-1", "bare-draft");

      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      const after = useTerminalInputStore.getState();
      expect(after.getHistoryLength("term-1")).toBe(1);
      expect(after.getDraftInput("term-1")).toBe("bare-draft");
    });

    it("should be a no-op when no matching entries exist", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "draft", "project-b");

      const before = useTerminalInputStore.getState();
      useTerminalInputStore.getState().resetForProjectSwitch("project-a");
      const after = useTerminalInputStore.getState();

      expect(after).toBe(before);
    });
  });

  describe("getProjectDraftInputs", () => {
    it("should return only drafts for the specified project, stripped of project prefix", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "echo hello", "project-a");
      store.setDraftInput("term-2", "ls -la", "project-a");
      store.setDraftInput("term-3", "other project draft", "project-b");

      const drafts = useTerminalInputStore.getState().getProjectDraftInputs("project-a");
      expect(drafts).toEqual({ "term-1": "echo hello", "term-2": "ls -la" });
    });
  });

  describe("getDraftProjectIds (#11352)", () => {
    it("returns the distinct project ids that hold a draft", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "a", "project-a");
      store.setDraftInput("term-2", "b", "project-a");
      store.setDraftInput("term-3", "c", "project-b");

      expect(new Set(useTerminalInputStore.getState().getDraftProjectIds())).toEqual(
        new Set(["project-a", "project-b"])
      );
    });

    it("ignores bare terminal-id keys with no project context", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "no project"); // key is just the terminalId
      store.setDraftInput("term-2", "scoped", "project-a");

      expect(useTerminalInputStore.getState().getDraftProjectIds()).toEqual(["project-a"]);
    });
  });

  describe("restoreProjectDraftInputs", () => {
    it("should not overwrite drafts from other projects", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "other project draft", "project-b");

      useTerminalInputStore.getState().restoreProjectDraftInputs("project-a", {
        "term-1": "project-a draft",
      });

      expect(useTerminalInputStore.getState().getDraftInput("term-1", "project-b")).toBe(
        "other project draft"
      );
      expect(useTerminalInputStore.getState().getDraftInput("term-1", "project-a")).toBe(
        "project-a draft"
      );
    });

    it("should skip empty keys and values", () => {
      useTerminalInputStore.getState().restoreProjectDraftInputs("project-a", {
        "": "should be skipped",
        "term-1": "",
        "term-2": "valid",
      });

      const drafts = useTerminalInputStore.getState().getProjectDraftInputs("project-a");
      expect(drafts).toEqual({ "term-2": "valid" });
    });

    it("should round-trip through getProjectDraftInputs and restoreProjectDraftInputs", () => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput("term-1", "echo hello", "project-a");
      store.setDraftInput("term-2", "npm test", "project-a");
      store.setDraftInput("term-3", "other project", "project-b");

      // Capture project-a drafts
      const captured = useTerminalInputStore.getState().getProjectDraftInputs("project-a");

      // Clear all state
      useTerminalInputStore.getState().clearAllDraftInputs();

      // Restore project-a drafts
      useTerminalInputStore.getState().restoreProjectDraftInputs("project-a", captured);

      expect(useTerminalInputStore.getState().getDraftInput("term-1", "project-a")).toBe(
        "echo hello"
      );
      expect(useTerminalInputStore.getState().getDraftInput("term-2", "project-a")).toBe(
        "npm test"
      );
      // project-b was cleared and not restored
      expect(useTerminalInputStore.getState().getDraftInput("term-3", "project-b")).toBe("");
    });
  });

  /**
   * The routing target for the type-anywhere rescue (#11134). A stale target is
   * worse than none: routing a prompt into a terminal that has been removed, or
   * one owned by another view, is exactly the harm the feature exists to fix.
   */
  describe("lastTypedAgentTarget", () => {
    it("records the agent and workspace that were typed into", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");

      expect(useTerminalInputStore.getState().lastTypedAgentTarget).toEqual({
        terminalId: "term-1",
        workspaceId: "ws-1",
      });
    });

    it("keeps a referentially stable target when re-recording the same agent", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");
      const first = useTerminalInputStore.getState().lastTypedAgentTarget;
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");

      // Every keystroke re-records; a fresh object each time would wake every
      // subscriber for nothing.
      expect(useTerminalInputStore.getState().lastTypedAgentTarget).toBe(first);
    });

    it("drops the target when its terminal is removed", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");
      useTerminalInputStore.getState().clearTerminalState("term-1");

      expect(useTerminalInputStore.getState().lastTypedAgentTarget).toBeNull();
    });

    it("keeps the target when a different terminal is removed", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");
      useTerminalInputStore.getState().clearTerminalState("term-2");

      expect(useTerminalInputStore.getState().lastTypedAgentTarget?.terminalId).toBe("term-1");
    });

    it("drops the target when a project switch discards its terminal", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "project-a");
      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      expect(useTerminalInputStore.getState().lastTypedAgentTarget).toBeNull();
    });

    it("keeps the target when a project switch preserves its terminal", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "project-a");
      useTerminalInputStore.getState().resetForProjectSwitch("project-a", new Set(["term-1"]));

      expect(useTerminalInputStore.getState().lastTypedAgentTarget?.terminalId).toBe("term-1");
    });

    it("keeps a target belonging to another workspace when a project resets", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "project-b");
      useTerminalInputStore.getState().resetForProjectSwitch("project-a");

      expect(useTerminalInputStore.getState().lastTypedAgentTarget?.terminalId).toBe("term-1");
    });

    it("drops the target on a full reset", () => {
      useTerminalInputStore.getState().recordLastTypedAgentTarget("term-1", "ws-1");
      useTerminalInputStore.getState().clearAllDraftInputs();

      expect(useTerminalInputStore.getState().lastTypedAgentTarget).toBeNull();
    });
  });
});
