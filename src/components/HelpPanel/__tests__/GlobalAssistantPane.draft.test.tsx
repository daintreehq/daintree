// @vitest-environment jsdom
/**
 * With the real composer: a draft typed under one ownership survives input
 * moving away and main handing it back on its own, and goes out under the new
 * ownership, never the old (#16098).
 */
import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

const apis = vi.hoisted(
  () =>
    [] as Array<{
      stamp: unknown;
      disposed: boolean;
      terminalSubmit: ReturnType<typeof vi.fn>;
    }>
);

vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("@/store/canopyStore", () => ({
  useCanopyStore: (select: (state: { isOpen: boolean }) => unknown) => select({ isOpen: false }),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => false,
  subscribeProjectViewLifecycle: () => () => {},
}));
vi.mock("@/services/assistantSubject", () => ({
  assistantTerminalApi: (_subject: unknown, stamp: unknown) => {
    const api = {
      stamp,
      disposed: false,
      terminalSubmit: vi.fn(async () => {}),
      terminalSendKey: vi.fn(async () => {}),
      dispose: () => {
        api.disposed = true;
      },
    };
    apis.push(api);
    return api;
  },
}));
vi.mock("@/components/Canopy/CanopyTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    CanopyTerminal: ({
      onStreamChange,
    }: {
      onStreamChange?: (state: {
        watchId: number | null;
        ended: boolean;
        secretPrompt: boolean;
      }) => void;
    }) => {
      useEffect(() => {
        onStreamChange?.({ watchId: 1, ended: false, secretPrompt: false });
      }, [onStreamChange]);
      return <div data-testid="global-terminal" />;
    },
  };
});

const { GlobalAssistantPane } = await import("../GlobalAssistantPane");
const { useHelpPanelStore } = await import("@/store/helpPanelStore");

const subject = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "g1",
  incarnation: 2,
};

const running = (inputOwner: string, inputEpoch: number): GlobalAssistantView => ({
  phase: "running",
  generation: 1,
  agentId: "claude",
  terminalId: "g1",
  attachments: [],
  inputOwner,
  inputEpoch,
  subject,
  agentState: null,
});

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;

describe("GlobalAssistantPane draft across input handovers", () => {
  let listeners: Set<(state: GlobalAssistantView) => void>;

  beforeAll(async () => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    await primeRadix();
  });

  afterAll(() => {
    if (originalRangeRects) {
      Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    } else {
      delete (Range.prototype as Partial<Range>).getClientRects;
    }
    Range.prototype.getBoundingClientRect = originalRangeBounds;
  });

  beforeEach(() => {
    apis.length = 0;
    listeners = new Set();
    setCurrentViewStore(createWorktreeStore());
    useTerminalInputStore.setState({
      draftInputs: new Map(),
      commandHistory: new Map(),
      sentPrompts: new Map(),
      hybridInputAutoFocus: false,
    });
    useHelpPanelStore.setState({ isOpen: true, globalSelected: true, globalTarget: null });
    Object.assign(window, {
      electron: {
        help: {
          attachGlobalAssistant: vi.fn(async () => ({
            attachmentId: "a1",
            state: running("a1", 1),
          })),
          detachGlobalAssistant: vi.fn(async () => {}),
          setGlobalAssistantInputEligible: vi.fn(async () => {}),
          onGlobalAssistantChanged: vi.fn((callback: (state: GlobalAssistantView) => void) => {
            listeners.add(callback);
            return () => listeners.delete(callback);
          }),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { electron?: unknown }).electron;
  });

  it("keeps the draft through an automatic handover and sends it under the new ownership", async () => {
    const result = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <GlobalAssistantPane isVisible controlsHost={null} onOpenDocs={() => {}} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    // The composer is lazy: let its chunk and the attach settle.
    await vi.waitFor(() => expect(result.container.querySelector(".cm-editor")).not.toBeNull());
    const editor = () =>
      EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
    const push = async (state: GlobalAssistantView) => {
      await act(async () => {
        for (const listener of [...listeners]) listener(state);
      });
    };

    await act(async () => {
      const view = editor();
      view.dispatch({ changes: { from: 0, insert: "half a thought" }, userEvent: "input.type" });
    });

    // Another window takes input, then lets go; main hands it straight back.
    await push(running("b1", 2));
    expect(editor().state.doc.toString()).toBe("half a thought");
    await push(running("a1", 3));
    await vi.waitFor(() =>
      expect(apis.at(-1)?.stamp).toEqual({ attachmentId: "a1", inputEpoch: 3 })
    );
    expect(editor().state.doc.toString()).toBe("half a thought");

    await act(async () => {
      runScopeHandlers(editor(), new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    await vi.waitFor(() => expect(apis.at(-1)?.terminalSubmit).toHaveBeenCalled());
    expect(apis.at(-1)?.terminalSubmit.mock.calls[0]?.[1]).toBe("half a thought");
    // Nothing went through the stream opened under the first ownership.
    expect(apis[0]?.disposed).toBe(true);
    expect(apis[0]?.terminalSubmit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(editor().state.doc.toString()).toBe(""));
  });
});
