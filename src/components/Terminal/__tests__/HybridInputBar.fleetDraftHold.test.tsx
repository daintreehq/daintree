// @vitest-environment jsdom
/**
 * Arming a fleet mirrors the primary's draft into every other armed composer,
 * but a pane's own unsent draft comes back when it leaves the fleet (#14949).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
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
  useTerminalInputStore.setState({ draftInputs: new Map() });
  useFleetArmingStore.getState().clear();
});

afterEach(() => {
  cleanup();
  useFleetArmingStore.getState().clear();
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
  const content = container
    .querySelector(`[data-pane="${id}"] .cm-content`)
    ?.cloneNode(true);
  if (!(content instanceof HTMLElement)) return "";
  for (const placeholder of content.querySelectorAll(".cm-placeholder")) placeholder.remove();
  return content.textContent ?? "";
}

function seedDraft(id: string, text: string): void {
  useTerminalInputStore.getState().setDraftInput(id, text);
}

function draftOf(id: string): string {
  return useTerminalInputStore.getState().getDraftInput(id);
}

describe("HybridInputBar keeps a pane's own draft through a fleet", () => {
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
});
