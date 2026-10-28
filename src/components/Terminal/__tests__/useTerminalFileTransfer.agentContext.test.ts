/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { PluginSendToAgentRefusalReason } from "@shared/types/plugin";

vi.mock("@/clients", () => ({
  terminalClient: { write: vi.fn<(terminalId: string, data: string) => void>() },
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    notifyUserInput: vi.fn(),
    focus: vi.fn(),
    get: vi.fn(() => null),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({}) },
}));
const { draftAgentContext, getDraftRefusal, requestPaneFocus } = vi.hoisted(() => ({
  draftAgentContext: vi.fn(),
  getDraftRefusal: vi.fn<(terminalId: string) => PluginSendToAgentRefusalReason | null>(),
  requestPaneFocus: vi.fn<(paneId: string, surface: string) => boolean>(() => true),
}));
vi.mock("@/services/agentHandoff/agentDraft", () => ({ draftAgentContext, getDraftRefusal }));
vi.mock("../paneFocusRequest", () => ({ requestPaneFocus }));

import { useTerminalFileTransfer } from "../useTerminalFileTransfer";
import { terminalClient } from "@/clients";
import {
  AGENT_CONTEXT_DRAG_MIME,
  encodeAgentContextDragPayload,
} from "@shared/utils/agentContextDrag";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

const TERMINAL_ID = "term-1";

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

describe("useTerminalFileTransfer — agent context on the xterm surface", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    getDraftRefusal.mockReturnValue(null);
    draftAgentContext.mockImplementation((terminalId: string) => ({
      status: "drafted",
      terminalId,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup();
    container.remove();
  });

  function renderTransfer(onDropSelect = vi.fn()) {
    const hook = renderHook(() => {
      const ref = useRef<HTMLDivElement>(container);
      return useTerminalFileTransfer(ref, {
        terminalId: TERMINAL_ID,
        onDropSelect,
        launchAgentId: "claude",
      });
    });
    return { ...hook, onDropSelect };
  }

  function dispatch(
    type: string,
    serialized = "",
    types: string[] = [AGENT_CONTEXT_DRAG_MIME, "text/plain"]
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = {
      types,
      dropEffect: "none",
      files: [],
      getData: (format: string) => (format === AGENT_CONTEXT_DRAG_MIME ? serialized : ""),
    };
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => {
      container.dispatchEvent(event);
    });
    return { event, dataTransfer };
  }

  const payload = encodeAgentContextDragPayload({ v: 1, text: "Card body", title: "Fix login" });

  it("shows the drop affordance over an agent pane that can take the draft", () => {
    const { result } = renderTransfer();
    dispatch("dragenter");
    const { event, dataTransfer } = dispatch("dragover");

    expect(result.current).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("routes the drop to the pane's draft, never the PTY, and lands focus in the bar", () => {
    const { onDropSelect } = renderTransfer();
    dispatch("drop", payload);

    expect(draftAgentContext).toHaveBeenCalledWith(TERMINAL_ID, {
      text: "Card body",
      title: "Fix login",
      sourceLabel: undefined,
    });
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(onDropSelect).toHaveBeenCalledTimes(1);
    expect(requestPaneFocus).toHaveBeenCalledExactlyOnceWith(TERMINAL_ID, "hybridInput");
    expect(onDropSelect.mock.invocationCallOrder[0]!).toBeLessThan(
      requestPaneFocus.mock.invocationCallOrder[0]!
    );
  });

  it("refuses the drag over a pane with no input bar, and writes nothing to it", () => {
    getDraftRefusal.mockReturnValue("not-agent");
    const { result, onDropSelect } = renderTransfer();
    dispatch("dragenter");
    const { event, dataTransfer } = dispatch("dragover");

    expect(result.current).toBe(false);
    // Claimed and refused rather than ignored, so xterm's helper textarea
    // cannot take the `text/plain` half as typed input.
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");

    draftAgentContext.mockReturnValue({ status: "refused", reason: "not-agent" });
    const drop = dispatch("drop", payload);
    expect(drop.event.defaultPrevented).toBe(true);
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(onDropSelect).not.toHaveBeenCalled();
    expect(requestPaneFocus).not.toHaveBeenCalled();
  });

  it("refuses a drag that also carries files over a shell, rather than showing a file target", () => {
    getDraftRefusal.mockReturnValue("not-agent");
    const { result } = renderTransfer();
    const mixed = ["Files", AGENT_CONTEXT_DRAG_MIME, "text/plain"];
    dispatch("dragenter", "", mixed);
    const { dataTransfer } = dispatch("dragover", "", mixed);

    expect(result.current).toBe(false);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("does nothing with a forged payload", () => {
    const { onDropSelect } = renderTransfer();
    dispatch("drop", JSON.stringify({ v: 9, text: "x" }));
    expect(draftAgentContext).not.toHaveBeenCalled();
    expect(terminalClient.write).not.toHaveBeenCalled();
    expect(onDropSelect).not.toHaveBeenCalled();
  });
});
