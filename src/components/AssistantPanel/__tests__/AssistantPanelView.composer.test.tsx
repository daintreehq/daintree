// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AssistantPanelView } from "../AssistantPanelView";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import { installPreviewShims } from "../__preview__/previewShims";

vi.mock("../AssistantBootSplash", () => ({
  AssistantBootSplash: ({ onDone }: { onDone: () => void }) => {
    useEffect(onDone, [onDone]);
    return null;
  },
}));

installPreviewShims();
// CodeMirror measures text ranges; jsdom has no layout implementation.
Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const project = { id: "project-a", path: "/project-a", name: "A", emoji: "", lastOpened: 0 };
const composerId = "assistant-session-a";
const emptyState = { ...PROSE_SPECIMEN, turns: [] };

beforeEach(() => {
  useProjectStore.setState({ currentProject: project });
  useTerminalInputStore.setState({ draftInputs: new Map(), externalDraftRevision: 0 });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
  useTerminalInputStore.getState().clearAllDraftInputs();
});

function panel(state = emptyState, onRetractedDraftConsumed = vi.fn()) {
  return (
    <WorktreeStoreContext.Provider value={createWorktreeStore()}>
      <AssistantPanelView
        state={state}
        composerId={composerId}
        onSubmit={() => true}
        onInterrupt={() => {}}
        onDecideApproval={() => {}}
        onRetractedDraftConsumed={onRetractedDraftConsumed}
      />
    </WorktreeStoreContext.Provider>
  );
}

describe("assistant composer drafts", () => {
  it.each([
    ["Plan a change", "Help me plan a change to this project"],
    ["Check the agents", "Check the agents in this project and tell me what needs attention"],
    ["Review the worktrees", "Review this project's worktrees and summarize the work in progress"],
  ])("fills and focuses the mounted editor from %s", async (label, prompt) => {
    const input = useTerminalInputStore.getState();
    input.setDraftInput("assistant-session-b", "Other session", project.id);
    input.setDraftInput(composerId, "Other project", "project-b");
    const { getByRole } = render(panel());
    const editor = getByRole("textbox");

    fireEvent.click(getByRole("button", { name: label }));

    await waitFor(() => {
      expect(editor.textContent).toBe(prompt);
      expect(document.activeElement).toBe(editor);
    });
    expect(input.getDraftInput(composerId, project.id)).toBe(prompt);
    expect(input.getDraftInput("assistant-session-b", project.id)).toBe("Other session");
    expect(input.getDraftInput(composerId, "project-b")).toBe("Other project");
  });

  it("restores a retracted follow-up into the mounted editor", async () => {
    const consumed = vi.fn();
    const { getByRole, rerender } = render(panel(emptyState, consumed));
    const editor = getByRole("textbox");

    rerender(panel({ ...emptyState, retractedDraft: "Use the existing worktree" }, consumed));

    await waitFor(() => {
      expect(editor.textContent).toBe("Use the existing worktree");
      expect(document.activeElement).toBe(editor);
    });
    expect(consumed).toHaveBeenCalledOnce();
  });
});
