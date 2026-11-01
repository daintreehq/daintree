// @vitest-environment jsdom
/**
 * Arming a fleet mirrors the primary's draft into every other armed composer,
 * but a pane's own unsent draft comes back when it leaves the fleet (#14949).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { subscribeFleetDraftHoldRelease } from "@/store/fleetDraftHoldRelease";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { writeComposerDraftThrough } from "@/services/voiceCorrectionLanding";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

function agentPanel(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
  } as PtyPanelData;
}

let stopHoldRelease: () => void;

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panels = ["pane-a", "pane-b", "pane-c"].map(agentPanel);
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { [WT_ID]: panels.map((p) => p.id) },
    focusedId: "pane-a",
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), fleetDraftHolds: new Map() });
  useFleetArmingStore.getState().clear();
  stopHoldRelease = subscribeFleetDraftHoldRelease();
});

afterEach(() => {
  cleanup();
  stopHoldRelease();
  useFleetArmingStore.getState().clear();
  useTerminalInputStore.setState({ draftInputs: new Map(), fleetDraftHolds: new Map() });
});

function bars(ids: string[]) {
  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        {ids.map((id) => (
          <div key={id} data-pane={id}>
            <HybridInputBar terminalId={id} cwd={WT_ID} agentId="claude" onSend={() => {}} />
          </div>
        ))}
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

/** The document's text, without the placeholder an empty editor shows. */
function editorText(container: HTMLElement, id: string): string {
  const content = container.querySelector(`[data-pane="${id}"] .cm-content`)?.cloneNode(true);
  if (!(content instanceof HTMLElement)) throw new Error(`no composer mounted for ${id}`);
  for (const placeholder of content.querySelectorAll(".cm-placeholder")) placeholder.remove();
  return content.textContent ?? "";
}

function seedDraft(id: string, text: string): void {
  useTerminalInputStore.getState().setDraftInput(id, text);
}

function draftOf(id: string): string {
  return useTerminalInputStore.getState().getDraftInput(id);
}

function editorOf(container: HTMLElement, id: string): EditorView {
  return EditorView.findFromDOM(
    container.querySelector<HTMLElement>(`[data-pane="${id}"] .cm-editor`)!
  )!;
}

async function type(container: HTMLElement, id: string, text: string): Promise<void> {
  const view = editorOf(container, id);
  await act(async () => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      userEvent: "input.type",
    });
  });
}

async function deleteRange(container: HTMLElement, id: string, from: number, to: number) {
  const view = editorOf(container, id);
  await act(async () => {
    view.dispatch({ changes: { from, to }, userEvent: "delete" });
  });
}

async function focus(id: string): Promise<void> {
  await act(async () => {
    usePanelStore.setState({ focusedId: id });
  });
}

describe("HybridInputBar keeps a pane's own draft through a fleet", () => {
  it("mirrors every typed character into mounted followers without writing an older draft back", async () => {
    const { container } = render(bars(["pane-a", "pane-b", "pane-c"]));
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b", "pane-c"]);
    });

    let text = "";
    for (const character of "retry this send") {
      text += character;
      await type(container, "pane-a", character);
      for (const id of ["pane-a", "pane-b", "pane-c"]) {
        expect(editorText(container, id)).toBe(text);
        expect(draftOf(id)).toBe(text);
      }
    }
  });

  it("shows the primary's draft while armed and gives the follower its own back on disarm", async () => {
    seedDraft("pane-a", "shared instruction");
    seedDraft("pane-b", "half-written for b");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});

    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    expect(editorText(container, "pane-b")).toBe("shared instruction");
    expect(draftOf("pane-b")).toBe("shared instruction");

    await act(async () => {
      useFleetArmingStore.getState().disarmId("pane-b");
    });
    expect(editorText(container, "pane-b")).toBe("half-written for b");
    expect(draftOf("pane-b")).toBe("half-written for b");
    expect(editorText(container, "pane-a")).toBe("shared instruction");
  });

  it("gives an empty primary's followers their drafts back when the fleet is cleared", async () => {
    seedDraft("pane-b", "b in progress");
    seedDraft("pane-c", "c in progress");
    const { container } = render(bars(["pane-a", "pane-b", "pane-c"]));
    await act(async () => {});

    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b", "pane-c"]);
    });
    expect(editorText(container, "pane-b")).toBe("");
    expect(editorText(container, "pane-c")).toBe("");

    await act(async () => {
      useFleetArmingStore.getState().clear();
    });
    expect(editorText(container, "pane-b")).toBe("b in progress");
    expect(editorText(container, "pane-c")).toBe("c in progress");
  });

  it("keeps the fleet's latest draft in the pane it came from when another pane took over", async () => {
    seedDraft("pane-a", "fix the");
    seedDraft("pane-b", "b in progress");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });

    await focus("pane-b");
    await type(container, "pane-b", " flaky test");
    expect(editorText(container, "pane-a")).toBe("fix the flaky test");

    await act(async () => {
      useFleetArmingStore.getState().clear();
    });
    expect(editorText(container, "pane-a")).toBe("fix the flaky test");
    expect(editorText(container, "pane-b")).toBe("b in progress");
  });

  it("writes a pane's typing through for a correction once it takes the fleet over (#15873)", async () => {
    seedDraft("pane-a", "fix the");
    seedDraft("pane-b", "b in progress");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    await focus("pane-b");
    const view = editorOf(container, "pane-b");

    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: " flaky test" },
        userEvent: "input.type",
      });
      writeComposerDraftThrough("pane-b", undefined);
      expect(draftOf("pane-b")).toBe("fix the flaky test");
    });
  });

  it("gives a pane that wasn't mounted its own draft when it next mounts", async () => {
    seedDraft("pane-a", "shared instruction");
    seedDraft("pane-b", "half-written for b");
    const view = render(bars(["pane-a"]));
    await act(async () => {});

    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    expect(draftOf("pane-b")).toBe("shared instruction");
    await act(async () => {
      useFleetArmingStore.getState().clear();
    });
    await act(async () => {
      view.rerender(bars(["pane-a", "pane-b"]));
    });

    expect(editorText(view.container, "pane-b")).toBe("half-written for b");
  });

  it("gives the last armed pane its draft back once nothing is left to follow", async () => {
    seedDraft("pane-a", "shared instruction");
    seedDraft("pane-b", "half-written for b");
    seedDraft("pane-c", "c in progress");
    const { container } = render(bars(["pane-a", "pane-b", "pane-c"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b", "pane-c"]);
    });

    await act(async () => {
      useFleetArmingStore.getState().disarmId("pane-a");
    });
    // B and C still make a fleet with no primary: neither has its draft back yet.
    expect(editorText(container, "pane-b")).toBe("shared instruction");
    await act(async () => {
      useFleetArmingStore.getState().disarmId("pane-c");
    });

    expect(editorText(container, "pane-b")).toBe("half-written for b");
    expect(editorText(container, "pane-c")).toBe("c in progress");
  });

  it("leaves no step of the fleet's draft to undo into once the pane's own is back", async () => {
    seedDraft("pane-a", "shared instruction");
    seedDraft("pane-b", "half-written for b");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    await focus("pane-b");
    // Deleted from the fleet's draft: undone, it would come back into B's own.
    await deleteRange(container, "pane-b", 0, "shared ".length);
    expect(draftOf("pane-a")).toBe("instruction");

    await act(async () => {
      useFleetArmingStore.getState().clear();
    });
    const isMac = /Mac/.test(navigator.platform);
    await act(async () => {
      runScopeHandlers(
        editorOf(container, "pane-b"),
        new KeyboardEvent("keydown", { key: "z", metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });

    expect(editorText(container, "pane-b")).toBe("half-written for b");
  });

  it("holds a pane's own draft again when its fleet is cleared and re-armed at once", async () => {
    seedDraft("pane-a", "shared instruction");
    seedDraft("pane-b", "half-written for b");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });

    await act(async () => {
      useFleetArmingStore.getState().clear();
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    expect(editorText(container, "pane-b")).toBe("shared instruction");

    await act(async () => {
      useFleetArmingStore.getState().clear();
    });
    expect(editorText(container, "pane-b")).toBe("half-written for b");
  });

  it("gives a pane that had no draft an empty composer back", async () => {
    seedDraft("pane-a", "shared instruction");
    const { container } = render(bars(["pane-a", "pane-b"]));
    await act(async () => {});
    await act(async () => {
      useFleetArmingStore.getState().armIds(["pane-a", "pane-b"]);
    });
    expect(editorText(container, "pane-b")).toBe("shared instruction");
    expect(useTerminalInputStore.getState().fleetDraftHolds.get("pane-b")?.draft).toBe("");

    await act(async () => {
      useFleetArmingStore.getState().disarmId("pane-b");
    });

    expect(editorText(container, "pane-b")).toBe("");
    expect(useTerminalInputStore.getState().draftInputs.has("pane-b")).toBe(false);
  });
});
