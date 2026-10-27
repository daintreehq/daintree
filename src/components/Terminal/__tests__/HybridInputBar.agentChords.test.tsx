// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

// The composer reads the chords from the agent registry by its `agentId`, so
// these drive the whole route: registry, the composer's latest state, and the
// editor's keydown, in the extension order the composer builds.
describe("HybridInputBar agent Option chords", () => {
  const WT_ID = "/repo/wt";

  beforeEach(() => {
    initBuiltInPanelKinds();
    setCurrentViewStore(createWorktreeStore());
    // Drafts outlive the composer, so one test's draft would greet the next.
    useTerminalInputStore.setState({ draftInputs: new Map() });
    const panel = {
      id: "term-1",
      title: "terminal",
      kind: "terminal",
      cwd: WT_ID,
      cols: 120,
      rows: 40,
      worktreeId: WT_ID,
      location: "grid",
      hasPty: true,
      runtimeStatus: "running",
    } as PtyPanelData;
    usePanelStore.setState({
      panelsById: { [panel.id]: panel },
      panelIds: [panel.id],
      panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
      focusedId: panel.id,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function renderComposer(agentId: BuiltInAgentId | undefined) {
    const onSendKey = vi.fn();
    const composer = (id: BuiltInAgentId | undefined) => (
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar
            terminalId="term-1"
            cwd={WT_ID}
            agentId={id}
            onSend={() => {}}
            onSendKey={onSendKey}
          />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    const { container, rerender } = render(composer(agentId));
    await act(async () => {});
    const content = container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    content.focus();
    return {
      onSendKey,
      content,
      view,
      becomes: async (next: BuiltInAgentId | undefined) => {
        rerender(composer(next));
        await act(async () => {});
      },
    };
  }

  function press(content: HTMLElement, key: string, keyCode: number, code: string) {
    const event = new KeyboardEvent("keydown", {
      key,
      code,
      keyCode,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      content.dispatchEvent(event);
    });
    return event;
  }

  const pressOptionP = (content: HTMLElement) => press(content, "π", 80, "KeyP");

  it("sends Option+P, Option+T and Option+O from a Claude composer to the agent and keeps the draft", async () => {
    const { onSendKey, content, view } = await renderComposer("claude");
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "tighten the retry loop" } });
    });

    const events = [
      press(content, "π", 80, "KeyP"),
      press(content, "†", 84, "KeyT"),
      press(content, "ø", 79, "KeyO"),
    ];

    expect(onSendKey.mock.calls).toEqual([["alt+p"], ["alt+t"], ["alt+o"]]);
    expect(events.map((event) => event.defaultPrevented)).toEqual([true, true, true]);
    expect(view.state.doc.toString()).toBe("tighten the retry loop");
  });

  it("sends Alt+P as Windows and Linux deliver it, from an empty draft", async () => {
    const { onSendKey, content, view } = await renderComposer("claude");

    const event = press(content, "p", 80, "KeyP");

    expect(onSendKey).toHaveBeenCalledExactlyOnceWith("alt+p");
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("");
  });

  it("leaves Option+P to type in another agent's composer and in a plain terminal's", async () => {
    for (const agentId of ["codex", undefined] as const) {
      const { onSendKey, content } = await renderComposer(agentId);

      const event = pressOptionP(content);

      expect(onSendKey, `${agentId ?? "plain terminal"}`).not.toHaveBeenCalled();
      expect(event.defaultPrevented, `${agentId ?? "plain terminal"}`).toBe(false);
      cleanup();
    }
  });

  it("follows the agent the terminal is running as it changes", async () => {
    const { onSendKey, content, becomes } = await renderComposer(undefined);

    await becomes("claude");
    const asClaude = pressOptionP(content);
    expect(onSendKey).toHaveBeenCalledExactlyOnceWith("alt+p");
    expect(asClaude.defaultPrevented).toBe(true);

    onSendKey.mockClear();
    await becomes("codex");
    const asCodex = pressOptionP(content);
    expect(onSendKey).not.toHaveBeenCalled();
    expect(asCodex.defaultPrevented).toBe(false);
  });
});
